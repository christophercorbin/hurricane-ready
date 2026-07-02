# One-time bootstrap: a least-privilege role in the DNS/management account
# (438465156498) that the app deploy accounts assume to manage records in the
# christophercorbin.cloud hosted zone. Apply once with the mgmt profile:
#   tofu -chdir=infra/dns-bootstrap init
#   tofu -chdir=infra/dns-bootstrap apply   # AWS_PROFILE/-var creds: personal-christopher-corbin
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

variable "zone_id" {
  type    = string
  default = "Z08882413R82BOPJVWS7Z"
}

variable "deploy_account_ids" {
  type    = list(string)
  default = ["385467776718", "590716168923"] # sandbox (Bim Weather), eportfolio-prod (math-mentor)
}

variable "external_id" {
  type    = string
  default = "corbin-dns-delegation"
}

data "aws_iam_policy_document" "trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]
    principals {
      type        = "AWS"
      identifiers = [for id in var.deploy_account_ids : "arn:aws:iam::${id}:root"]
    }
    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [var.external_id]
    }
  }
}

data "aws_iam_policy_document" "records" {
  statement {
    sid       = "WriteRecordsInZone"
    effect    = "Allow"
    actions   = ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets"]
    resources = ["arn:aws:route53:::hostedzone/${var.zone_id}"]
  }
  statement {
    sid       = "TrackChanges"
    effect    = "Allow"
    actions   = ["route53:GetChange"]
    resources = ["arn:aws:route53:::change/*"]
  }
  statement {
    sid       = "FindZone"
    effect    = "Allow"
    actions   = ["route53:ListHostedZonesByName", "route53:ListHostedZones"]
    resources = ["*"]
  }
}

resource "aws_iam_role" "record_writer" {
  name               = "Route53RecordWriter"
  assume_role_policy = data.aws_iam_policy_document.trust.json
}

resource "aws_iam_role_policy" "record_writer" {
  name   = "route53-record-writer"
  role   = aws_iam_role.record_writer.id
  policy = data.aws_iam_policy_document.records.json
}

output "role_arn" {
  value = aws_iam_role.record_writer.arn
}
