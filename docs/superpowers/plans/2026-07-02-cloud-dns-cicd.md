# cloud-dns Repo + CI/CD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a `cloud-dns` GitHub repo whose CI/CD (OIDC, S3-backed state, auto-apply on merge) deploys the shared cross-account `Route53RecordWriter` IAM role in the DNS/management account.

**Architecture:** A one-time `seed.sh` (AWS CLI, mgmt admin) creates the S3 state bucket, DynamoDB lock table, GitHub OIDC provider, and the `cloud-dns-ci` deploy role. From then on, GitHub Actions assumes `cloud-dns-ci` via OIDC, runs `tofu plan` on PRs and `tofu apply -auto-approve` on merge to `main`, with state in S3.

**Tech Stack:** OpenTofu 1.8.0 (`hashicorp/aws ~> 5.0`), AWS S3/DynamoDB/IAM/Route53, GitHub Actions (OIDC), `gh` CLI, bash.

## Global Constraints

- DNS/management account: **438465156498** (`personal-christopher-corbin`). Region **us-east-1**.
- GitHub repo: **`christophercorbin/cloud-dns`**.
- State bucket: **`cloud-dns-tfstate-438465156498`**; lock table: **`cloud-dns-tflock`**; state key: **`cloud-dns/terraform.tfstate`**.
- CI deploy role: **`arn:aws:iam::438465156498:role/cloud-dns-ci`**; trusts only `repo:christophercorbin/cloud-dns:ref:refs/heads/main` (apply) and `repo:christophercorbin/cloud-dns:pull_request` (plan), `aud=sts.amazonaws.com`.
- Managed role: **`Route53RecordWriter`** — trust = deploy-account roots `385467776718` + `590716168923`, external id **`corbin-dns-delegation`**; permissions scoped to zone **`Z08882413R82BOPJVWS7Z`** (`route53:ChangeResourceRecordSets`,`ListResourceRecordSets`), `route53:GetChange` on `change/*`, list ops on `*`.
- All third-party GitHub Actions **SHA-pinned**. Known pins: `actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5`, `aws-actions/configure-aws-credentials@cabfdba3510de1431bac9dba27511d97497fc100 # v5`. Resolve `opentofu/setup-opentofu` SHA in Task 4.
- 100% AWS, no Cloudflare. Auto-apply on merge (no manual gate) is intentional.
- Never commit Terraform state or `.terraform/`.

---

### Task 1: Scaffold the cloud-dns repo

**Files:**
- Create: `~/Eportfolio/cloud-dns/README.md`
- Create: `~/Eportfolio/cloud-dns/.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: a git repo at `~/Eportfolio/cloud-dns` on branch `main`, pushed to `github.com/christophercorbin/cloud-dns`.

- [ ] **Step 1: Create the directory and init git**

```bash
mkdir -p ~/Eportfolio/cloud-dns && cd ~/Eportfolio/cloud-dns && git init -b main
```

- [ ] **Step 2: Write `.gitignore`**

```gitignore
.terraform/
*.tfstate
*.tfstate.*
.terraform.lock.hcl
crash.log
*.tfvars
```

- [ ] **Step 3: Write `README.md`**

```markdown
# cloud-dns

Shared cross-account DNS bootstrap for christophercorbin.cloud apps.

Owns the `Route53RecordWriter` IAM role in the DNS/management account
(438465156498). App repos (Bim Weather, math-mentor) assume this role to write
records in the `christophercorbin.cloud` hosted zone.

## Deploy model

- **One-time seed** (`./seed.sh`, mgmt admin): creates the S3 state bucket,
  DynamoDB lock table, GitHub OIDC provider, and the `cloud-dns-ci` CI role.
- **CI/CD**: GitHub Actions assumes `cloud-dns-ci` via OIDC. `tofu plan` on PRs,
  `tofu apply -auto-approve` on merge to `main`. State in S3.

See `docs/` in the hurricane-ready repo for the design + plan.
```

- [ ] **Step 4: Commit**

```bash
cd ~/Eportfolio/cloud-dns
git add README.md .gitignore
git commit -m "chore: scaffold cloud-dns repo"
```

- [ ] **Step 5: Create the GitHub repo and push**

```bash
cd ~/Eportfolio/cloud-dns
gh repo create christophercorbin/cloud-dns --private --source=. --remote=origin --push
```
Expected: repo created, `main` pushed. Verify: `gh repo view christophercorbin/cloud-dns --json name,visibility`.

---

### Task 2: Terraform root (Route53RecordWriter + S3 backend)

**Files:**
- Create: `~/Eportfolio/cloud-dns/versions.tf`
- Create: `~/Eportfolio/cloud-dns/main.tf`
- Create: `~/Eportfolio/cloud-dns/backend.tf`

**Interfaces:**
- Consumes: (at apply time) the S3 bucket + lock table from Task 5's seed.
- Produces: IAM role `arn:aws:iam::438465156498:role/Route53RecordWriter`; output `role_arn`.

- [ ] **Step 1: Write `versions.tf`**

```hcl
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
```

- [ ] **Step 2: Write `main.tf`**

```hcl
# Cross-account role: app deploy accounts assume this to manage records in the
# christophercorbin.cloud hosted zone. Deployed by CI (see .github/workflows).
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
```

- [ ] **Step 3: Write `backend.tf`**

```hcl
terraform {
  backend "s3" {
    bucket         = "cloud-dns-tfstate-438465156498"
    key            = "cloud-dns/terraform.tfstate"
    region         = "us-east-1"
    dynamodb_table = "cloud-dns-tflock"
    encrypt        = true
  }
}
```

- [ ] **Step 4: fmt + validate (offline — backend not seeded yet)**

Run: `cd ~/Eportfolio/cloud-dns && tofu fmt && tofu init -backend=false && tofu validate`
Expected: `Success! The configuration is valid.` (If `tofu` absent, use `terraform`.)

- [ ] **Step 5: Commit**

```bash
cd ~/Eportfolio/cloud-dns
git add versions.tf main.tf backend.tf
git commit -m "feat: Route53RecordWriter role with S3 backend"
```

---

### Task 3: Seed script

**Files:**
- Create: `~/Eportfolio/cloud-dns/seed.sh`

**Interfaces:**
- Consumes: mgmt admin credentials.
- Produces: S3 bucket `cloud-dns-tfstate-438465156498`, DynamoDB table `cloud-dns-tflock`, OIDC provider for `token.actions.githubusercontent.com`, IAM role `cloud-dns-ci`.

- [ ] **Step 1: Write `seed.sh`**

```bash
#!/usr/bin/env bash
# One-time bootstrap for cloud-dns CI/CD. Idempotent. Run with mgmt admin creds:
#   AWS_PROFILE=personal-christopher-corbin ./seed.sh
set -euo pipefail

PROFILE="${AWS_PROFILE:-personal-christopher-corbin}"
REGION="us-east-1"
ACCOUNT="438465156498"
BUCKET="cloud-dns-tfstate-${ACCOUNT}"
TABLE="cloud-dns-tflock"
ROLE="cloud-dns-ci"
REPO="christophercorbin/cloud-dns"
OIDC_URL="token.actions.githubusercontent.com"
OIDC_ARN="arn:aws:iam::${ACCOUNT}:oidc-provider/${OIDC_URL}"

awsp() { command aws --profile "$PROFILE" --region "$REGION" "$@"; }

echo "== S3 state bucket =="
if awsp s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  echo "  exists"
else
  awsp s3api create-bucket --bucket "$BUCKET" # us-east-1 needs no LocationConstraint
  echo "  created"
fi
awsp s3api put-bucket-versioning --bucket "$BUCKET" --versioning-configuration Status=Enabled
awsp s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
awsp s3api put-bucket-encryption --bucket "$BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

echo "== DynamoDB lock table =="
if awsp dynamodb describe-table --table-name "$TABLE" >/dev/null 2>&1; then
  echo "  exists"
else
  awsp dynamodb create-table --table-name "$TABLE" \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST
  awsp dynamodb wait table-exists --table-name "$TABLE"
  echo "  created"
fi

echo "== GitHub OIDC provider =="
if awsp iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >/dev/null 2>&1; then
  echo "  exists"
else
  awsp iam create-open-id-connect-provider \
    --url "https://${OIDC_URL}" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 1c58a3a8518e8759bf075b76b750d4f2df264fca
  echo "  created"
fi

echo "== CI deploy role =="
TRUST=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "${OIDC_ARN}" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": { "${OIDC_URL}:aud": "sts.amazonaws.com" },
      "StringLike": { "${OIDC_URL}:sub": [
        "repo:${REPO}:ref:refs/heads/main",
        "repo:${REPO}:pull_request"
      ] }
    }
  }]
}
JSON
)
if awsp iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  awsp iam update-assume-role-policy --role-name "$ROLE" --policy-document "$TRUST"
  echo "  exists (trust updated)"
else
  awsp iam create-role --role-name "$ROLE" --assume-role-policy-document "$TRUST"
  echo "  created"
fi

PERMS=$(cat <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ManageRecordWriterRole",
      "Effect": "Allow",
      "Action": [
        "iam:GetRole","iam:CreateRole","iam:DeleteRole","iam:TagRole","iam:UntagRole",
        "iam:ListRoleTags","iam:PutRolePolicy","iam:GetRolePolicy","iam:DeleteRolePolicy",
        "iam:ListRolePolicies","iam:ListAttachedRolePolicies","iam:UpdateAssumeRolePolicy",
        "iam:ListInstanceProfilesForRole"
      ],
      "Resource": "arn:aws:iam::${ACCOUNT}:role/Route53RecordWriter"
    },
    { "Sid": "State", "Effect": "Allow",
      "Action": ["s3:GetObject","s3:PutObject","s3:DeleteObject"],
      "Resource": "arn:aws:s3:::${BUCKET}/cloud-dns/*" },
    { "Sid": "StateList", "Effect": "Allow",
      "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::${BUCKET}" },
    { "Sid": "Lock", "Effect": "Allow",
      "Action": ["dynamodb:GetItem","dynamodb:PutItem","dynamodb:DeleteItem"],
      "Resource": "arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${TABLE}" }
  ]
}
JSON
)
awsp iam put-role-policy --role-name "$ROLE" --policy-name "cloud-dns-ci" --policy-document "$PERMS"

echo "== done =="
awsp iam get-role --role-name "$ROLE" --query 'Role.Arn' --output text
```

- [ ] **Step 2: Make executable + shellcheck**

Run: `cd ~/Eportfolio/cloud-dns && chmod +x seed.sh && (shellcheck seed.sh || echo "shellcheck not installed — skip")`
Expected: no shellcheck errors (warnings acceptable), or the skip message.

- [ ] **Step 3: Commit** (do NOT run seed.sh here — that is the Task 5 checkpoint)

```bash
cd ~/Eportfolio/cloud-dns
git add seed.sh
git commit -m "feat: idempotent seed script for state backend + CI OIDC role"
```

---

### Task 4: GitHub Actions workflows

**Files:**
- Create: `~/Eportfolio/cloud-dns/.github/workflows/plan.yml`
- Create: `~/Eportfolio/cloud-dns/.github/workflows/apply.yml`

**Interfaces:**
- Consumes: role `arn:aws:iam::438465156498:role/cloud-dns-ci`; S3 backend from Task 5.
- Produces: PR plan comments; auto-apply on merge to `main`.

- [ ] **Step 1: Resolve the setup-opentofu SHA**

Run: `gh api repos/opentofu/setup-opentofu/commits/v1 --jq .sha`
Record the printed 40-char SHA; use it below as `<SETUP_TOFU_SHA>` with a `# v1` comment.

- [ ] **Step 2: Write `.github/workflows/plan.yml`**

```yaml
name: plan
on:
  pull_request:
permissions:
  id-token: write
  contents: read
  pull-requests: write
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5
      - uses: opentofu/setup-opentofu@<SETUP_TOFU_SHA> # v1
        with:
          tofu_version: 1.8.0
      - uses: aws-actions/configure-aws-credentials@cabfdba3510de1431bac9dba27511d97497fc100 # v5
        with:
          role-to-assume: arn:aws:iam::438465156498:role/cloud-dns-ci
          aws-region: us-east-1
      - run: tofu init -input=false
      - run: tofu fmt -check
      - run: tofu validate
      - name: Plan
        run: tofu plan -no-color -input=false | tee plan.txt
      - name: Comment plan on PR
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          {
            echo '```'
            tail -c 60000 plan.txt
            echo '```'
          } > body.md
          gh pr comment "${{ github.event.pull_request.number }}" --body-file body.md
```

- [ ] **Step 3: Write `.github/workflows/apply.yml`**

```yaml
name: apply
on:
  push:
    branches: [main]
permissions:
  id-token: write
  contents: read
jobs:
  apply:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd # v5
      - uses: opentofu/setup-opentofu@<SETUP_TOFU_SHA> # v1
        with:
          tofu_version: 1.8.0
      - uses: aws-actions/configure-aws-credentials@cabfdba3510de1431bac9dba27511d97497fc100 # v5
        with:
          role-to-assume: arn:aws:iam::438465156498:role/cloud-dns-ci
          aws-region: us-east-1
      - run: tofu init -input=false
      - run: tofu apply -auto-approve -input=false
```

- [ ] **Step 4: Commit**

```bash
cd ~/Eportfolio/cloud-dns
git add .github/workflows/plan.yml .github/workflows/apply.yml
git commit -m "ci: plan on PR, auto-apply on merge (OIDC)"
```

---

### Task 5: Run the seed (INTERACTIVE CHECKPOINT — mgmt admin)

**Files:** none.

**Interfaces:**
- Consumes: `seed.sh` (Task 3), mgmt admin SSO session.
- Produces: live state backend + `cloud-dns-ci` role.

- [ ] **Step 1: Ensure SSO session**

Run: `aws sts get-caller-identity --profile personal-christopher-corbin --query Account --output text`
Expected: `438465156498`. If it errors, run `aws sso login --sso-session personal` first.

- [ ] **Step 2: Run the seed**

Run: `cd ~/Eportfolio/cloud-dns && AWS_PROFILE=personal-christopher-corbin ./seed.sh`
Expected: prints created/exists for each resource, ends with `arn:aws:iam::438465156498:role/cloud-dns-ci`.

- [ ] **Step 3: Verify idempotency**

Run: `cd ~/Eportfolio/cloud-dns && AWS_PROFILE=personal-christopher-corbin ./seed.sh`
Expected: every line reports `exists` (no errors) and the same role ARN.

- [ ] **Step 4: Verify the backend**

Run: `aws s3api head-bucket --bucket cloud-dns-tfstate-438465156498 --profile personal-christopher-corbin && aws dynamodb describe-table --table-name cloud-dns-tflock --profile personal-christopher-corbin --query 'Table.TableStatus' --output text`
Expected: no error; `ACTIVE`.

---

### Task 6: End-to-end CI verification (INTERACTIVE CHECKPOINT)

**Files:** none (uses pushed repo).

**Interfaces:**
- Consumes: seeded backend/role (Task 5), pushed config + workflows (Tasks 2–4).
- Produces: `Route53RecordWriter` created by CI; verified assumable by a deploy account.

- [ ] **Step 1: Push all committed work to origin**

Run: `cd ~/Eportfolio/cloud-dns && git push origin main`
Note: this push to `main` triggers `apply.yml`. Watch it: `gh run watch --repo christophercorbin/cloud-dns` (or `gh run list`).
Expected: the apply workflow succeeds and creates `Route53RecordWriter`. (The first apply runs on push since all files are already on main.)

- [ ] **Step 2: Verify the role was created by CI**

Run: `aws iam get-role --role-name Route53RecordWriter --profile personal-christopher-corbin --query 'Role.Arn' --output text`
Expected: `arn:aws:iam::438465156498:role/Route53RecordWriter`

- [ ] **Step 3: Exercise the PR plan path**

Make a trivial no-op PR (e.g. add a comment line to `main.tf`), open it, and confirm `plan.yml` posts a plan comment.
```bash
cd ~/Eportfolio/cloud-dns
git checkout -b test/plan-comment
printf '\n# plan-path smoke test\n' >> main.tf
git add main.tf && git commit -m "test: trigger plan workflow"
git push -u origin test/plan-comment
gh pr create --title "test: plan path" --body "Verifying plan comment." --base main
```
Expected: within a minute, the PR has a comment containing `No changes` or the plan output (the comment line is a no-op → "No changes. Your infrastructure matches the configuration."). Then close the PR: `gh pr close test/plan-comment --delete-branch`.

- [ ] **Step 4: Smoke-test cross-account assume**

Run: `aws sts assume-role --role-arn arn:aws:iam::438465156498:role/Route53RecordWriter --role-session-name smoke --external-id corbin-dns-delegation --profile personal-sandbox --query 'AssumedRoleUser.Arn' --output text`
Expected: an assumed-role ARN (confirms a deploy account can assume it with the external id).

---

### Task 7: Remove the superseded local bootstrap from hurricane-ready

**Files:**
- Delete: `hurricane-ready/infra/dns-bootstrap/main.tf`
- Delete: `hurricane-ready/infra/dns-bootstrap/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: hurricane-ready no longer carries the duplicated bootstrap (now owned by cloud-dns).

- [ ] **Step 1: Remove the directory**

```bash
cd ~/Eportfolio/hurricane-ready
git rm -r infra/dns-bootstrap
```

- [ ] **Step 2: Commit**

```bash
cd ~/Eportfolio/hurricane-ready
git commit -m "chore(infra): drop local dns-bootstrap (moved to cloud-dns repo + CI)"
```

Note: this is on the `feat/custom-domains` branch. The parent custom-domains plan's Task 1 (local bootstrap apply) is now delivered by cloud-dns; update that plan/ledger reference when resuming the domains work.

---

## Notes for the implementer

- Tasks 1–4 and 7 are file-writing/validation (delegatable). Tasks 5 and 6 are interactive checkpoints: they need the mgmt-admin SSO session and mutate the management account — get human authorization before running the seed and before pushing to `main` (which auto-applies).
- If `apply.yml` fails on `AccessDenied` for IAM actions, re-check the `cloud-dns-ci` inline policy in `seed.sh` covers the action on `Route53RecordWriter`, then re-run `seed.sh` (idempotent) and re-run the workflow.
- If `tofu init` fails with a backend/lock error on the first apply, confirm Task 5 created both the bucket and the table.
