/**
 * CI/CD wiring for Hurricane-Ready. Apply in the target AWS account, then set
 * GitHub repo variables from the outputs:
 *   AWS_DEPLOY_ROLE_ARN, ECR_REPOSITORY (and later ECS_CLUSTER/ECS_SERVICE).
 */
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
  region = var.region

  # The deploy role's ecs:UpdateService statement is conditioned on
  # aws:ResourceTag/project = "hurricane-ready" — tagging everything via
  # default_tags makes that condition impossible to miss on a new resource.
  default_tags {
    tags = {
      project = "hurricane-ready"
    }
  }
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "github_repo" {
  description = "GitHub org/repo allowed to assume the deploy role"
  type        = string
  default     = "christophercorbin/hurricane-ready"
}

variable "create_oidc_provider" {
  description = "Set false if this account already has the GitHub OIDC provider (e.g., from zero-downtime-pipeline)"
  type        = bool
  default     = true
}

# ---------- ECR ----------

resource "aws_ecr_repository" "app" {
  name                 = "hurricane-ready"
  image_tag_mutability = "MUTABLE" # latest tag moves; SHA tags are immutable in practice
  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last 20 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}

# ---------- GitHub OIDC deploy role ----------

resource "aws_iam_openid_connect_provider" "github" {
  count           = var.create_oidc_provider ? 1 : 0
  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  oidc_arn = var.create_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
}

resource "aws_iam_role" "deploy" {
  name = "hurricane-ready-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.oidc_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
        }
        StringLike = {
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_repo}:ref:refs/heads/main"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "deploy" {
  name = "deploy"
  role = aws_iam_role.deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "EcrAuth"
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Sid    = "EcrPush"
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability",
          "ecr:CompleteLayerUpload",
          "ecr:InitiateLayerUpload",
          "ecr:PutImage",
          "ecr:UploadLayerPart",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
        ]
        Resource = aws_ecr_repository.app.arn
      },
      {
        Sid    = "EcsRedeploy"
        Effect = "Allow"
        Action = [
          "ecs:UpdateService",
          "ecs:DescribeServices",
        ]
        Resource = "*"
        Condition = {
          StringEquals = { "aws:ResourceTag/project" = "hurricane-ready" }
        }
      },
    ]
  })
}

# ---------- Outputs (become GitHub repo variables) ----------

output "github_deploy_role_arn" {
  description = "Set as AWS_DEPLOY_ROLE_ARN repo variable"
  value       = aws_iam_role.deploy.arn
}

output "ecr_repository" {
  description = "Set as ECR_REPOSITORY repo variable"
  value       = aws_ecr_repository.app.repository_url
}
