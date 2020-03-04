#!/bin/sh
set -e

# Determine the action type.
action="$1"
if [ -z "$action" ]; then
    echo "error: missing argument: action"
    exit 1
fi

# Get the object bucket/key to expand.
bucket="$2"
archive="$3"
object_acl="$4"

if [ -z "$bucket" ]; then
    echo "error: missing argument: bucket"
    exit 1
elif [ -z "$archive" ]; then
    echo "error: missing argument: archive"
    exit 1
elif [ -z "$object_acl" ]; then
    echo "error: missing argument: object_acl"
    exit 1
fi

if [ "$action" == "Create" ] || [ "$action" == "Update" ]; then
    # Download the archive from the archive bucket and unpack it into a local folder.
    echo "| Downloading S3 archive $bucket/$archive..."
    aws s3 cp s3://$bucket/$archive .
    echo "| Done."
    TMP_ARCHIVE_DIR=site_contents
    echo "| Decompressing archive to $TMP_ARCHIVE_DIR..."
    mkdir $TMP_ARCHIVE_DIR
    tar -xzvf $archive -C $TMP_ARCHIVE_DIR
    echo "| Done."

    # Synchronize the contents of the local folder and site bucket, deleting
    # whatever files exist remotely but not locally.
    echo "| Running AWS CLI to sync to $bucket (with ACL $object_acl)..."
    aws s3 sync $TMP_ARCHIVE_DIR s3://$bucket --acl "$object_acl" --delete
    echo "| Done."

    rm -rf $TMP_ARCHIVE_DIR
elif [ "$action" == "Delete" ]; then
    echo "| Running AWS CLI to delete entire bucket $bucket..."
    aws s3 rm s3://$bucket --recursive
    echo "| Done."
else
    echo "error: unrecognized action: $action"
    exit 1
fi
