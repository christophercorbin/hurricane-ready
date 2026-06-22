/**
 * Public entry point: CloudFront -> VPC Origin -> internal ALB -> ECS task.
 * The ALB is internal=true (see ecs.tf), so this distribution is the *only*
 * way in from the internet.
 */

# ---------- Custom domain + TLS (prep for #23) ----------
# Until you have a real domain, leave both empty: the distribution falls back
# to the *.cloudfront.net default cert. With a real domain provisioned and an
# ACM cert in us-east-1 (manual: aws acm request-certificate + DNS validation
# in Route53 or whichever DNS provider you use), set both and re-apply.
#
# When both are set:
#   - viewer_certificate switches to the ACM cert with TLSv1.2_2021 minimum
#   - distribution `aliases` is populated so the custom domain reaches it
#   - HSTS `preload` directive is emitted (it's meaningless on cloudfront.net,
#     so we keep it off until a real domain backs the claim)

variable "aliases" {
  description = "Custom domain aliases for the CloudFront distribution. Empty list keeps the *.cloudfront.net default. All entries must be covered by the ACM certificate."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "ARN of a us-east-1 ACM certificate covering every entry in `aliases`. Required when `aliases` is non-empty."
  type        = string
  default     = ""
  validation {
    condition     = (length(var.aliases) == 0) == (var.acm_certificate_arn == "")
    error_message = "`aliases` and `acm_certificate_arn` must both be set, or both be empty."
  }
}

locals {
  use_custom_domain = var.acm_certificate_arn != ""
}

# ---------- VPC Origin: CloudFront's connection to the internal ALB ----------

resource "aws_cloudfront_vpc_origin" "alb" {
  vpc_origin_endpoint_config {
    name                   = "hurricane-ready-alb"
    arn                    = aws_lb.app.arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "http-only"

    # Required field even though we use HTTP. CloudFront ignores SSL settings
    # when origin_protocol_policy=http-only.
    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }
}

# ---------- Security response headers ----------
# Adds HSTS, a content-security policy, and the usual hardening headers to
# every response. CSP allows the inline <script>/<style> the dashboard relies
# on plus the Leaflet CDN and CARTO basemap tiles; the API the browser calls
# (/api/status) is same-origin, so connect-src 'self' is sufficient.

resource "aws_cloudfront_response_headers_policy" "security" {
  name = "hurricane-ready-security-headers"

  security_headers_config {
    strict_transport_security {
      access_control_max_age_sec = 63072000 # 2 years
      include_subdomains         = true
      # HSTS preload only when a real domain + TLSv1.2_2021 cert backs the claim.
      # Preload on *.cloudfront.net is meaningless (the preload list won't
      # accept it) and emitting it over a TLSv1-capable connection is exactly
      # the misconfig the preload list rejects. Issue #23.
      preload  = local.use_custom_domain
      override = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    content_security_policy {
      override = true
      content_security_policy = join("; ", [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
        "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com",
        "img-src 'self' data: https://*.basemaps.cartocdn.com https://*.rainviewer.com https://cdn.star.nesdis.noaa.gov",
        "connect-src 'self' https://api.rainviewer.com",
        "font-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ])
    }
  }
}

# ---------- CloudFront distribution ----------

resource "aws_cloudfront_distribution" "app" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "hurricane-ready"
  price_class     = "PriceClass_100" # US + EU edges only — Caribbean audience is served by both

  # WAFv2 ACL: managed common-rule-set + known-bad-inputs + per-IP rate cap.
  # See waf.tf. Closes #22 — the origin task is no longer a single-flight
  # DoS target.
  web_acl_id = aws_wafv2_web_acl.cf.arn

  aliases = var.aliases

  origin {
    domain_name = aws_lb.app.dns_name
    origin_id   = "alb-vpc-origin"

    vpc_origin_config {
      vpc_origin_id = aws_cloudfront_vpc_origin.alb.id
    }
  }

  # Default behavior: respect origin Cache-Control headers (issue #24).
  # CachingOptimized lets icons / OG image / preloaded assets cache at the
  # edge (origin sends `public, max-age=86400`) while the service worker and
  # manifest stay live (origin sends `no-cache`).
  default_cache_behavior {
    target_origin_id       = "alb-vpc-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = "658327ea-f89d-4fab-a63d-7e88639e58f6" # CachingOptimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # Belt-and-suspenders: pin dynamic endpoints to CachingDisabled so even if
  # origin Cache-Control headers ever drifted, these never cache at the edge.
  # `/` and `/index.html` cover the dashboard HTML, which the origin sends
  # without a Cache-Control header — under CachingOptimized that would
  # default to a 24h TTL and viewers would see stale HTML for up to a day
  # after each deploy (no invalidation is wired up in release.yml).
  # /api/* covers /api/status (polled every 60s) and the push subscribe
  # endpoints. /healthz must always reach the origin so health probes see
  # the live `persistenceBroken` / `stale` flags.
  ordered_cache_behavior {
    path_pattern           = "/"
    target_origin_id       = "alb-vpc-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
    origin_request_policy_id   = "216adef6-5c7f-47e4-b989-5492eafa07d3" # AllViewer
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  ordered_cache_behavior {
    path_pattern           = "/index.html"
    target_origin_id       = "alb-vpc-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
    origin_request_policy_id   = "216adef6-5c7f-47e4-b989-5492eafa07d3" # AllViewer
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "alb-vpc-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
    origin_request_policy_id   = "216adef6-5c7f-47e4-b989-5492eafa07d3" # AllViewer
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  ordered_cache_behavior {
    path_pattern           = "/healthz"
    target_origin_id       = "alb-vpc-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
    origin_request_policy_id   = "216adef6-5c7f-47e4-b989-5492eafa07d3" # AllViewer
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # Without an ACM cert: stay on the default *.cloudfront.net cert (which
  # forces TLSv1 minimum — see issue #23). With an ACM cert: tighten to
  # TLSv1.2_2021 and serve the custom aliases. Setting `null` on the inactive
  # fields makes the provider omit them from the API call.
  viewer_certificate {
    cloudfront_default_certificate = local.use_custom_domain ? null : true
    acm_certificate_arn            = local.use_custom_domain ? var.acm_certificate_arn : null
    ssl_support_method             = local.use_custom_domain ? "sni-only" : null
    minimum_protocol_version       = local.use_custom_domain ? "TLSv1.2_2021" : null
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
}

# ---------- Outputs ----------

output "dashboard_url" {
  description = "Public dashboard URL (CloudFront)"
  value       = "https://${aws_cloudfront_distribution.app.domain_name}"
}
