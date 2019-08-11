# Pulumify GitHub Action

This repo contains the definition for the Pulumify GitHub Action. This action uses [Pulumi](https://pulumi.com)
to automatically build and deploy static websites to any cloud, including Pull Request integrated previews.

## How to Use

To enable Pulumify in your repo, you must take three steps:

1) [Enable GitHub Actions in your account](https://github.com/features/actions/signup/).

2) [Configure your cloud credentials using GitHub secrets](
   https://help.github.com/en/articles/virtual-environments-for-github-actions#creating-and-using-secrets-encrypted-variables).
   For example, to deploy to AWS, you'll need `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` values with appropriate
   IAM permissions to deploy an S3 website to your account.

3) Commit the following file as `.github/workflows/pulumify.yml`:

    ```
    name: Pulumify
    on: pull_request
    jobs:
      updateLivePreview:
        name: Update Live Preview
        runs-on: ubuntu-latest
        steps:
        - uses: actions/checkout@master
          if: github.event.action != 'closed'
          with:
            ref: ${{ github.event.pull_request.head.ref }}
            fetch-depth: 1
        - uses: pulumi/actions-pulumify@master
          env:
            AWS_ACCESS_KEY_ID: ${{ secrets.AWS_ACCESS_KEY_ID }}
            AWS_SECRET_ACCESS_KEY: ${{ secrets.AWS_SECRET_ACCESS_KEY }}
            GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
            PULUMI_ACCESS_TOKEN: ${{ secrets.PULUMI_ACCESS_TOKEN }}
            PULUMIFY_BUILD: make ensure && hugo --buildFuture -e $GITHUB_SHA
            PULUMIFY_ROOT: public
    ```

   Feel free to customize  the `PULUMIFY_BUILD` or `PULUMIFY_ROOT` settings as appropriate.

After these three steps, the Pulumify GitHub Action will comment on your PRs automatically with URLs to your websites.
