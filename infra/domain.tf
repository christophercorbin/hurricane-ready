# Custom-domain resources for Bim Weather. All DNS records land in the
# authoritative christophercorbin.cloud zone (mgmt account) via aws.dns.

variable "domain" {
  description = "Custom subdomain for the dashboard. Empty disables the custom domain."
  type        = string
  default     = "bimweather.christophercorbin.cloud"
}

variable "dns_role_arn" {
  description = "ARN of the Route53RecordWriter role in the DNS management account."
  type        = string
  default     = "arn:aws:iam::438465156498:role/Route53RecordWriter"
}

variable "dns_zone_id" {
  description = "Hosted zone id for christophercorbin.cloud (authoritative, mgmt account)."
  type        = string
  default     = "Z08882413R82BOPJVWS7Z"
}

variable "dns_external_id" {
  description = "External id required to assume the Route53RecordWriter role."
  type        = string
  default     = "corbin-dns-delegation"
}

# us-east-1 cert for CloudFront (default provider is us-east-1).
resource "aws_acm_certificate" "app" {
  count             = local.use_custom_domain ? 1 : 0
  domain_name       = var.domain
  validation_method = "DNS"
  lifecycle {
    create_before_destroy = true
  }
}

# DNS validation records, written cross-account into the authoritative zone.
resource "aws_route53_record" "acm_validation" {
  for_each = local.use_custom_domain ? {
    for o in aws_acm_certificate.app[0].domain_validation_options : o.domain_name => {
      name   = o.resource_record_name
      type   = o.resource_record_type
      record = o.resource_record_value
    }
  } : {}

  provider        = aws.dns
  zone_id         = var.dns_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "app" {
  count                   = local.use_custom_domain ? 1 : 0
  certificate_arn         = aws_acm_certificate.app[0].arn
  validation_record_fqdns = [for r in aws_route53_record.acm_validation : r.fqdn]
}

# Public alias records -> CloudFront.
resource "aws_route53_record" "alias_a" {
  count    = local.use_custom_domain ? 1 : 0
  provider = aws.dns
  zone_id  = var.dns_zone_id
  name     = var.domain
  type     = "A"
  alias {
    name                   = aws_cloudfront_distribution.app.domain_name
    zone_id                = aws_cloudfront_distribution.app.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "alias_aaaa" {
  count    = local.use_custom_domain ? 1 : 0
  provider = aws.dns
  zone_id  = var.dns_zone_id
  name     = var.domain
  type     = "AAAA"
  alias {
    name                   = aws_cloudfront_distribution.app.domain_name
    zone_id                = aws_cloudfront_distribution.app.hosted_zone_id
    evaluate_target_health = false
  }
}

output "custom_domain_url" {
  value = local.use_custom_domain ? "https://${var.domain}" : null
}
