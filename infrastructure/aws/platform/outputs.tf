output "public_url" {
  value = local.use_custom_domain ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.app.domain_name}"
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.app.id
}

output "web_bucket" {
  value = aws_s3_bucket.web.id
}

output "evidence_bucket" {
  value = aws_s3_bucket.evidence.id
}

output "api_alb_dns_name" {
  value = aws_lb.api.dns_name
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  value = aws_ecs_service.api.name
}

output "rds_endpoint" {
  value = aws_db_instance.postgres.address
}

output "rds_instance_identifier" {
  value = aws_db_instance.postgres.identifier
}

output "rds_subnet_group_name" {
  value = aws_db_subnet_group.main.name
}

output "rds_security_group_id" {
  value = aws_security_group.db.id
}

output "rds_master_secret_arn" {
  value     = aws_db_instance.postgres.master_user_secret[0].secret_arn
  sensitive = true
}

output "redis_primary_endpoint" {
  value = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.main.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.web.id
}

output "jobs_queue_url" {
  value = aws_sqs_queue.jobs.url
}

output "alarms_topic_arn" {
  value = aws_sns_topic.alarms.arn
}

output "feature_liveness" {
  value = var.feature_liveness
}

output "liveness_provider" {
  value = upper(var.liveness_provider)
}

output "feature_secure_envelope" {
  value = var.feature_secure_envelope
}

output "feature_webrtc_relay" {
  value = var.feature_webrtc_relay
}

output "sync_encryption_key_id" {
  value = aws_kms_key.sync_encryption.key_id
}

output "sync_receipt_signing_key_id" {
  value = aws_kms_key.sync_receipt_signing.key_id
}

output "guardduty_malware_protection_enabled" {
  value = var.enable_guardduty_malware_protection
}
