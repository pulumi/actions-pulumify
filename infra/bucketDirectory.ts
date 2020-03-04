import * as aws from "@pulumi/aws";
import * as awssdk from "aws-sdk";
import * as awsx from "@pulumi/awsx";
import * as child_process from "child_process";
import * as fs from "fs";
import * as https from "https";
import * as mime from "mime";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as tar from "tar";
import * as tmp from "tmp";
import * as uuid from "uuid/v1";

// TODO(joe): better region management -- since it can be overridden.
const region = aws.config.region;

/**
 * BucketDirectory is a component that makes it easy to synchronize an entire local directory in your
 * project with an S3 Bucket. Individual files will be uploaded as S3 Objects using a strategy of your choice.
 * This is generally more efficient than manually uploading individual S3 Objects as individual resources.
 */
export class BucketDirectory extends pulumi.ComponentResource {
    /**
     * The name of this BucketDirectory resource.
     */
    public readonly name: string;
    /**
     * The synchronization approach taken.
     */
    public readonly syncStrategy: BucketSyncStrategy;
    /**
     * The relative directory copied into the bucket.
     */
    public readonly source: string;
    /**
     * The S3 bucket the contents have been copied to.
     */
    public readonly bucket: aws.s3.Bucket;
    /**
     * The [canned ACL](https://docs.aws.amazon.com/AmazonS3/latest/dev/acl-overview.html#canned-acl) applied, if any.
     */
    public readonly objectAcl?: string;

    /**
     * The child resource allocated to perform the directory sync'ing.
     */
    private readonly syncer: BucketDirectoryLambdaSyncer;

    /**
     * Provisions a new BucketDirectory resource with a given name, arguments, and options.
     */
    constructor(name: string, args: BucketDirectoryArgs, opts?: pulumi.ComponentResourceOptions) {
        super("awsx:s3:BucketDirectory", name, args, opts);

        this.name = name;
        this.syncStrategy = args.syncStrategy || "server-lambda";
        this.source = args.source;
        this.bucket = args.bucket;
        this.objectAcl = args.objectAcl;

        switch (this.syncStrategy) {
            case "server-lambda":
                this.syncServerLambda();
                break;
            case "server-ecstask":
                this.syncServerEcsTask();
                break;
            case "local-sync":
                this.syncLocalSync();
                break;
            case "local-copy":
                this.syncLocalCopy();
                break;
            default:
                throw new Error(`Unrecognized syncStratety: ${this.syncStrategy}`);
        }
    }

    /**
     * syncServerLambda compresses and uploads an entire directory as an object to a bucket and then uses server-side
     * copying to maximize bandwidth. Unfortunately, due to lambda limitations, this stops working at 512MB.
     */
    private syncServerLambda(): void {
        // Create a temporary file containing the contents and upload it.
        const archive = this.createTempArchive();

        // Create the dynamic resource that'll decompress and bulk-sync the contents.
        const syncer = new BucketDirectoryLambdaSyncer(`${this.name}-syncer`, {
            archive,
            objectAcl: this.objectAcl,
        }, { parent: this });
    }

    private syncServerEcsTask(): void {
        // Create a temporary file containing the contents and upload it.
        const archive = this.createTempArchive();

        // Create the dynamic resource that'll decompress and bulk-sync the contents.
        const syncer = new BucketDirectoryEcsTaskSyncer(`${this.name}-syncer`, {
            archive,
            objectAcl: this.objectAcl,
        }, { parent: this });
    }

    /**
     * syncLocalSync uses the `aws s3 sync` command, via the CLI, to synchronize a folder with a target S3
     * Bucket. This copies a file at a time from the client but is slightly more efficient than materializing
     * an actual Pulumi asset and resource for every S3 Object.
     */
    private syncLocalSync(): void {
        // TODO(joe): unfortunately, because this is guarded, previews won't show that updates will occur.
        if (!pulumi.runtime.isDryRun()) {
            this.bucket.bucket.apply(bucket => {
                try {
                    let cmd = `aws s3 sync ${this.source} s3://${bucket}`;
                    if (this.objectAcl) {
                        cmd += ` --acl="${this.objectAcl}"`;
                    }
                    child_process.execSync(cmd, { maxBuffer: 1024*1024*1024 });
                } catch (err) {
                    pulumi.log.error(`synchronizing ${this.source} to s3://${bucket} failed: ${err}`);
                }
            });
        }
    }

    /**
     * syncLocalCopy just traverses the filesystem recursively, and creates an S3 Object resource for each file.
     * This creates an asset and resource which isn't the most efficient approach, but works.
     */
    private syncLocalCopy(): void {
        // crawlDirectory recursive crawls the provided directory, applying the provided function
        // to every file it contains. Doesn't handle cycles from symlinks.
        function crawlDirectory(dir: string, f: (_: string) => void) {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                const filePath = `${dir}/${file}`;
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    crawlDirectory(filePath, f);
                }
                if (stat.isFile()) {
                    f(filePath);
                }
            }
        }

        crawlDirectory(this.source, (filePath: string) => {
            const relativeFilePath = filePath.replace(this.source + "/", "");
            const contentFile = new aws.s3.BucketObject(`${this.name}/${relativeFilePath}`, {
                acl: this.objectAcl,
                key: relativeFilePath,
                bucket: this.bucket,
                source: new pulumi.asset.FileAsset(filePath),
                contentType: mime.getType(filePath) || undefined,
            }, { parent: this });
        });
    }

    /**
     * createTempArchive is shared between the server-side variants (Lambda and ECS) to produce a temporary
     * archive that is uploaded to a bucket, so that we can hand off expensive copying to the server-side.
     */
    private createTempArchive(): aws.s3.BucketObject {
        // Upload the target directory a single object at a time. This allows us to minimize
        // copying over the Internet, and then to apply an efficient "S3 sync" from within the
        // Amazon data center, where bandwidth to the target S3 bucket will be maximized.
        const arch = tmp.fileSync({ postfix: ".tgz" }).name;

        // Tar up the contents, making sure to set the portable flag so we only detect changes
        // when the actual hash of the contents changes (and not non-portable timestamps, etc).
        tar.c({
            gzip: true,
            sync: true,
            file: arch,
            C: this.source,
            portable: true,
        }, fs.readdirSync(this.source));

        // TODO(joe): when archive can be an asset, we can just use this line, instead of manual tgzing:
        // const arch = new pulumi.asset.FileArchive(args.source);

        // Now create a single object in the target bucket to hold the resulting archive and return it.
        return new aws.s3.BucketObject(`${this.name}-archive`, {
            key: "__aws.s3.BucketDirectory.archive.tar.gz",
            bucket: this.bucket,
            source: new pulumi.asset.FileAsset(arch),
        }, { parent: this });
    }
}

// TODO(joe): allow copying to a sub-directory in the bucket.
export interface BucketDirectoryArgs {
    /**
     * The S3 bucket to copy the contents of the directory to.
     */
    bucket: aws.s3.Bucket;
    /**
     * The relative directory to copy into the bucket.
     */
    source: string;
    /**
     * The synchronization approach to take. If empty, the "server-lambda" strartegy is used, as it is the fastest.
     */
    syncStrategy?: BucketSyncStrategy;
    /**
     * The [canned ACL](https://docs.aws.amazon.com/AmazonS3/latest/dev/acl-overview.html#canned-acl) to apply.
     * Defaults to "private".
     */
    objectAcl?: string;
}

/**
 * BucketSyncStrategy controls how S3 objects are sync'd from the local project to the destination bucket.
 * This provides a set of options ranging from fast to slow, each with its own performance limits and characteristics.
 *
 * WARNING: switching between sync strategies will result in a period of time where your bucket is empty.
 */
export type BucketSyncStrategy =
    /**
     * The "server-lambda" strategy is generally fastest and cheapest option, however is limited by AWS Lambda's
     * standard memory and compute limitations. A single tgz will be produced and uploaded to a temporary bucket,
     * minimizing transfer time, and then the Lambda will sync the contents, maximizing S3 proximity and bandwidth.
     * Namely, for large contents exceeding 512MB, this approach will not work.
     */
    "server-lambda" |
    /**
     * The "server-ecstask" strategy is generally fast and cheap option, however requires that an ECS "Fargate"
     * cluster is provisioned, and so may cost more than "server-lambda," and is also limited by standard ECS "Fargate"
     * memory and compute limitations. A single tgz will be produced and uploaded to a temporary bucket, minimizing
     * transfer time, and then the Lambda will sync the contents, maximizing S3 proximity and bandwidth.
     */
    "server-ecstask" |
    /**
     * The "local-sync" strategy will run an `aws s3 sync` command locally to copy files. This uses optimizations
     * built into the AWS CLI, however is approximately equivalent to copying individual objects. This is slower than
     * the "server-*" family of strategies because files are not compressed while uploading.
     */
    "local-sync" |
    /**
     * The "local-copy" strategy will upload individual objects to your bucket one at a time. This will generally be
     * slower than "local-sync", because every S3 object will result in a distinct Pulumi asset and resource. This is
     * slower than the "server-*" family of strategies because files are not compressed while uploading.
     */
    "local-copy"
;

async function invokeLambdaSync(inputs: any, action: string): Promise<void> {
    try {
        const bucket = inputs["bucket"] as string;
        if (!bucket) {
            throw new Error("Missing bucket in BucketDirectory inputs");
        }
        const archiveKey = inputs["archiveKey"] as string;
        if (!archiveKey) {
            throw new Error("Missing archiveKey in BucketDirectory inputs");
        }
        const objectAcl = inputs["objectAcl"] as string;
        const syncFunc = inputs["syncFunc"] as string;
        if (!syncFunc) {
            throw new Error("Missing syncFunc ARN in BucketDirectory inputs");
        }

        // Run the copy function and then wait for it to finish.
        const lambda = new awssdk.Lambda({ region });
        const resp = await lambda.invoke({
            FunctionName: syncFunc,
            Payload: JSON.stringify({
                Action: action,
                Bucket: bucket,
                ArchiveKey: archiveKey,
                ObjectAcl: objectAcl,
            }),
        }).promise();
        if (resp && resp.FunctionError) {
            throw new Error(
                `Invoking sync function '${syncFunc}' failed [${resp.FunctionError}]: ${JSON.stringify(resp.Payload)}`);
        }
    } catch (err) {
        // TODO[pulumi/pulumi#2721]: this can go away once diagnostics for dynamic providers is improved.
        console.log(err);
        throw err;
    }
}

/**
 * BucketDirectoryLambdaSyncer is the implementation of the "server-lambda" sync strategy.
 */
class BucketDirectoryLambdaSyncer extends pulumi.dynamic.Resource  {
    private static provider = {
        create: async(inputs: any): Promise<pulumi.dynamic.CreateResult> => {
            await invokeLambdaSync(inputs, "Create");
            return { id: uuid(), outs: inputs };
        },
        update: async(id: pulumi.ID, olds: any, news: any): Promise<pulumi.dynamic.UpdateResult> => {
            if (olds.archiveEtag !== news.archiveEtag) {
                await invokeLambdaSync(news, "Update");
            }
            return { outs: news };
        },
        delete: async(id: pulumi.ID, olds: any): Promise<void> => {
            await invokeLambdaSync(olds, "Delete");
        },
    };

    private static createSyncFunc(name: string, bucket: pulumi.Output<string>, parent?: pulumi.Resource): pulumi.Output<string> {
        const syncFuncRole = new aws.iam.Role(`${name}-copyfunc-role`, {
            assumeRolePolicy: {
                Version: "2012-10-17",
                Statement: [{
                    Action: "sts:AssumeRole",
                    Principal: {
                        Service: "lambda.amazonaws.com"
                    },
                    Effect: "Allow",
                    Sid: "",
                }],
            },
            tags: {
              "Owner": "Pulumify",
            }
        }, { parent });
        const syncFunc = new aws.lambda.Function(`${name}-copyfunc`, {
            timeout: 60*5,
            memorySize: 1024,
            runtime: "python3.7",
            code: new pulumi.asset.FileArchive("./lambda/bin"),
            handler: "index.handler",
            role: syncFuncRole.arn,
            tags: {
              "Owner": "Pulumify"
            }
        }, { parent });

        // Allow Lambda to read/write from the S3 bucket.
        const bucketArn = pulumi.interpolate`arn:aws:s3:::${bucket}`;
        const syncFuncPolicy = new aws.iam.Policy(`${name}-copyfunc-policy`, {
            path: "/",
            policy: {
                Version: "2012-10-17",
                Statement: [
                    // Allow S3 Bucket operations.
                    {
                        Effect:"Allow",
                        Action: "s3:ListBucket",
                        Resource: bucketArn,
                    },
                    {
                        Effect: "Allow",
                        Action: [
                            "s3:PutObject",
                            "s3:PutObjectAcl",
                            "s3:GetObject",
                            "s3:GetObjectAcl",
                            "s3:DeleteObject"
                        ],
                        Resource: pulumi.interpolate`${bucketArn}/*`,
                    },
                    // Allow use of CloudWatch logs.
                    {
                        Action: "logs:*",
                        Resource: "arn:aws:logs:*:*:*",
                        Effect: "Allow",
                    },
                ],
            },
        }, { parent });
        const syncFuncPolicyAtt = new aws.iam.RolePolicyAttachment(`${name}-copyfunc-policy-att`, {
            role: syncFuncRole.name,
            policyArn: syncFuncPolicy.arn,
        }, { parent });

        // Return the ARN for the function, but also join with the policy attachment so consumers don't try
        // to use the function before the policy attachment has occurred (this can lead to permissions errors).
        return pulumi.all([ syncFunc.arn, syncFuncPolicyAtt.id ]).apply(([ arn, _ ]) => arn);
    }

    constructor(name: string, args: BucketDirectorySyncerArgs, opts?: pulumi.ResourceOptions) {
        // Create a Lambda function that will copy and extract files using "aws s3 sync".
        opts = opts || {};
        const syncFunc = BucketDirectoryLambdaSyncer.createSyncFunc(name, args.archive.bucket, opts.parent);

        // Now initialize the dynamic resource provider, etc.
        const superArgs = {
            syncFunc,
            bucket: args.archive.bucket,
            archiveKey: args.archive.key,
            archiveEtag: args.archive.etag,
            objectAcl: args.objectAcl,
        };
        super(BucketDirectoryLambdaSyncer.provider, name, superArgs, opts);
    }
}

async function invokeTaskSync(inputs: any, action: string): Promise<void> {
    try {
        const bucket = inputs["bucket"] as string;
        if (!bucket) {
            throw new Error("Missing bucket in BucketDirectory inputs");
        }
        const archiveKey = inputs["archiveKey"] as string;
        if (!archiveKey) {
            throw new Error("Missing archiveKey in BucketDirectory inputs");
        }
        const objectAcl = inputs["objectAcl"] as string;
        if (!objectAcl) {
            throw new Error("Missing objectAcl in BucketDirectory inputs");
        }
        const syncCluster = inputs["syncCluster"] as string;
        if (!syncCluster) {
            throw new Error("Missing syncCluster ARN in BucketDirectory inputs");
        }
        const syncSecurityGroupIds = inputs["syncSecurityGroupIds"] as string[];
        if (!syncSecurityGroupIds) {
            throw new Error("Missing syncSecurityGroupIds in BucketDirectoryInputs");
        }
        const syncSubnetIds = inputs["syncSubnetIds"] as string[];
        if (!syncSubnetIds) {
            throw new Error("Missing syncSubnetIds in BucketDirectoryInputs");
        }
        const syncTask = inputs["syncTask"] as string;
        if (!syncTask) {
            throw new Error("Missing syncTask ARN in BucketDirectory inputs");
        }

        // Kick off the task to perform the copying.
        const ecs = new awssdk.ECS({ region });
        const runResp = await ecs.runTask({
            cluster: syncCluster,
            taskDefinition: syncTask,
            launchType: "FARGATE",
            networkConfiguration: {
                awsvpcConfiguration: {
                    assignPublicIp: "ENABLED",
                    securityGroups: syncSecurityGroupIds,
                    subnets: syncSubnetIds,
                },
            },
            overrides: {
                containerOverrides: [
                    {
                        name: "container",

                        // Pass the S3 URL of the uploaded tarball and destination
                        // bucket to the container task.
                        command: [
                            action,
                            bucket,
                            archiveKey,
                            objectAcl,
                        ],
                    },
                ],
            },
        }).promise();
        if (runResp && runResp.failures && runResp.failures.length) {
            throw new Error(
                `Invoking ECS task '${syncTask}' failed: ${JSON.stringify(runResp.failures)}`);
        }

        // Now wait for it to complete.
        // TODO(joe): note that this won't necessarily include failure information, because when
        //     a task fails, we need to inspect the logs to figure out why it failed.
        const waitResp = await ecs.waitFor("tasksStopped", {
            cluster: syncCluster,
            tasks: (runResp.tasks || []).map(t => t.taskArn!),
        }).promise();
        if (waitResp && waitResp.failures && waitResp.failures.length) {
            throw new Error(
                `Waiting for ECS task '${syncTask}' failed: ${JSON.stringify(runResp.failures)}`);
        }
    } catch (err) {
        // TODO[pulumi/pulumi#2721]: this can go away once diagnostics for dynamic providers is improved.
        console.log(err);
        throw err;
    }
}

/**
 * BucketDirectoryEcsTaskSyncer is the implementation of the "server-ecstask" sync strategy.
 */
class BucketDirectoryEcsTaskSyncer extends pulumi.dynamic.Resource  {
    private static provider = {
        create: async(inputs: any): Promise<pulumi.dynamic.CreateResult> => {
            await invokeTaskSync(inputs, "Create");
            return { id: uuid(), outs: inputs };
        },
        update: async(id: pulumi.ID, olds: any, news: any): Promise<pulumi.dynamic.UpdateResult> => {
            if (olds.archiveEtag !== news.archiveEtag) {
                await invokeTaskSync(news, "Update");
            }
            return { outs: news };
        },
        delete: async(id: pulumi.ID, olds: any): Promise<void> => {
            await invokeTaskSync(olds, "Delete");
        },
    };

    private static createSyncTask(name: string, bucket: pulumi.Output<string>, parent?: pulumi.Resource): pulumi.Output<string> {
        // archiveHandler processes the uploads when they become available.
        const archiveHandler = new awsx.ecs.FargateTaskDefinition(`${name}-synctask`, {
            container: {
                image: awsx.ecs.Image.fromPath(`${name}-synctask-img`, "ecstask"),
                memory: 4096,
                cpu: 4,
            },
        }, { parent });

        // Return the handler's ARN.
        return archiveHandler.taskDefinition.arn;
    }

    constructor(name: string, args: BucketDirectorySyncerArgs, opts?: pulumi.ResourceOptions) {
        // Create an ECS Task that will copy and extract files using "aws s3 sync".
        opts = opts || {};
        const syncCluster = awsx.ecs.Cluster.getDefault();
        const syncTask = BucketDirectoryEcsTaskSyncer.createSyncTask(name, args.archive.bucket, opts.parent);

        // Now initialize the dynamic resource provider, etc.
        const superArgs = {
            syncCluster: syncCluster.cluster.arn,
            syncSecurityGroupIds: syncCluster.securityGroups.map(sg => sg.id),
            syncSubnetIds: syncCluster.vpc.publicSubnetIds,
            syncTask,
            bucket: args.archive.bucket,
            archiveKey: args.archive.key,
            archiveEtag: args.archive.etag,
            objectAcl: args.objectAcl || "private",
        };
        super(BucketDirectoryEcsTaskSyncer.provider, name, superArgs, opts);
    }
}


interface BucketDirectorySyncerArgs {
    /**
     * The archive to sync into the enclosing bucket.
     */
    archive: aws.s3.BucketObject;
    /**
     * The [canned ACL](https://docs.aws.amazon.com/AmazonS3/latest/dev/acl-overview.html#canned-acl) to apply.
     * Defaults to "private".
     */
    objectAcl?: string;
}
