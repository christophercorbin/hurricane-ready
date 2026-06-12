/**
 * Public entry point: CloudFront -> VPC Origin -> internal ALB -> ECS task.
 * The ALB is internal=true (see ecs.tf), so this distribution is the *only*
 * way in from the internet.
 */

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

# ---------- CloudFront distribution ----------

resource "aws_cloudfront_distribution" "app" {
  enabled         = true
  is_ipv6_enabled = true
  comment         = "hurricane-ready"
  price_class     = "PriceClass_100" # US + EU edges only — Caribbean audience is served by both

  origin {
    domain_name = aws_lb.app.dns_name
    origin_id   = "alb-vpc-origin"

    vpc_origin_config {
      vpc_origin_id = aws_cloudfront_vpc_origin.alb.id
    }
  }

  default_cache_behavior {
    target_origin_id       = "alb-vpc-origin"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    # Managed policies: CachingDisabled + AllViewer.
    # The app is dynamic (/api/status polled by the UI); caching here would
    # just create staleness with no real upside. Trade simple for correct.
    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" # CachingDisabled
    origin_request_policy_id = "216adef6-5c7f-47e4-b989-5492eafa07d3" # AllViewer
  }

  viewer_certificate {
    # Default *.cloudfront.net cert. Swap to ACM (us-east-1) + aliases when
    # there's a real domain to point at this.
    cloudfront_default_certificate = true
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
