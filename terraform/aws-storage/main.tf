terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

resource "aws_s3_bucket" "workspace_snapshots" {
  bucket        = var.bucket_name
  force_destroy = false

  tags = merge(var.tags, {
    Application = "ath-ide"
    Purpose     = "workspace-snapshots"
  })
}

resource "aws_s3_bucket_public_access_block" "workspace_snapshots" {
  bucket                  = aws_s3_bucket.workspace_snapshots.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "workspace_snapshots" {
  bucket = aws_s3_bucket.workspace_snapshots.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "workspace_snapshots" {
  bucket = aws_s3_bucket.workspace_snapshots.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "workspace_snapshots" {
  bucket = aws_s3_bucket.workspace_snapshots.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = var.kms_key_arn == "" ? "AES256" : "aws:kms"
      kms_master_key_id = var.kms_key_arn == "" ? null : var.kms_key_arn
    }
    bucket_key_enabled = var.kms_key_arn != ""
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "workspace_snapshots" {
  bucket = aws_s3_bucket.workspace_snapshots.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  rule {
    id     = "expire-noncurrent-snapshots"
    status = "Enabled"
    filter {
      prefix = "workspaces/"
    }
    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }
  }
}

data "aws_iam_policy_document" "workspace_bucket_transport" {
  statement {
    sid    = "DenyInsecureTransport"
    effect = "Deny"
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.workspace_snapshots.arn, "${aws_s3_bucket.workspace_snapshots.arn}/*"]
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "workspace_snapshots" {
  bucket = aws_s3_bucket.workspace_snapshots.id
  policy = data.aws_iam_policy_document.workspace_bucket_transport.json
}

data "aws_iam_policy_document" "workspace_worker" {
  statement {
    sid       = "ListWorkspaceSnapshots"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.workspace_snapshots.arn]
    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["workspaces/*"]
    }
  }

  statement {
    sid    = "ReadWriteWorkspaceSnapshots"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:GetObjectVersion",
    ]
    resources = ["${aws_s3_bucket.workspace_snapshots.arn}/workspaces/*"]
  }

  dynamic "statement" {
    for_each = var.kms_key_arn == "" ? [] : [var.kms_key_arn]
    content {
      sid       = "UseWorkspaceSnapshotKmsKey"
      effect    = "Allow"
      actions   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey", "kms:DescribeKey"]
      resources = [statement.value]
    }
  }
}

resource "aws_iam_policy" "workspace_worker" {
  name        = "${var.name_prefix}-workspace-s3"
  description = "Least-privilege S3 and optional KMS access for ATH IDE workspace snapshots"
  policy      = data.aws_iam_policy_document.workspace_worker.json
}
