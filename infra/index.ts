import * as aws from "@pulumi/aws";
import * as fs from "fs";
import * as mime from "mime";
import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import { BucketDirectory } from "./bucketDirectory";

// The content comes from a configurable location.
const config = new pulumi.Config();
const contentRoot = config.require("root");

// Create a bucket to store and serve the static content.
const contentBucket = new aws.s3.Bucket("content-bucket", {
    acl: "public-read",
    // Have S3 serve its contents as if it were a website. This is how we get the right behavior
    // for routes like "foo/", which S3 will automatically translate to "foo/index.html".
    website: {
        indexDocument: "index.html",
        errorDocument: "404.html",
    },
    tags: {
      "Owner": "Pulumify",
    }
});

// Upload the entire directory contents to the S3 bucket. To do this, we leverage the
// BucketDirectory component resource, rather than a collection of BucketObjects, so that
// we can optimize the data transfer into S3.
const content = new BucketDirectory("content", {
    bucket: contentBucket,
    source: contentRoot,
    objectAcl: "public-read",
    syncStrategy: "server-ecstask",
}, { parent: contentBucket });

// Export the bucket name.
export const bucket = contentBucket.bucket;

// Export the bucket's URL for easy access.
export const url = pulumi.interpolate`http://${contentBucket.websiteEndpoint}`;
