resource "aws_cloudwatch_log_group" "api" {
  name              = "/ecs/${local.name}/api"
  retention_in_days = 30
}

resource "random_password" "identity_hash" {
  length  = 64
  special = false
}

resource "random_password" "origin_verify" {
  length  = 48
  special = false
}

resource "aws_secretsmanager_secret" "identity_hash" {
  name                    = "${local.name}/identity-hash"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = 30
}

resource "aws_secretsmanager_secret_version" "identity_hash" {
  secret_id     = aws_secretsmanager_secret.identity_hash.id
  secret_string = random_password.identity_hash.result
}

resource "aws_lb" "api" {
  name                       = substr("${local.name}-alb", 0, 32)
  internal                   = false
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = [for subnet in aws_subnet.public : subnet.id]
  enable_deletion_protection = var.deletion_protection
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "api" {
  name        = substr("${local.name}-api", 0, 32)
  port        = 3001
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  deregistration_delay = 30

  health_check {
    enabled             = true
    path                = "/api/v1/health"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      message_body = "Forbidden"
      status_code  = "403"
    }
  }
}

resource "aws_lb_listener_rule" "cloudfront_only" {
  listener_arn = aws_lb_listener.http.arn
  priority     = 100

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }

  condition {
    http_header {
      http_header_name = "X-SOS-Origin-Verify"
      values           = [random_password.origin_verify.result]
    }
  }
}

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_iam_role" "ecs_execution" {
  name = "${local.name}-ecs-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_execution_secrets" {
  role = aws_iam_role.ecs_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = [
          aws_db_instance.postgres.master_user_secret[0].secret_arn,
          aws_secretsmanager_secret.identity_hash.arn,
          aws_secretsmanager_secret.reunification_lookup.arn
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = [aws_kms_key.data.arn]
      }
    ]
  })
}

resource "aws_iam_role" "ecs_task" {
  name = "${local.name}-ecs-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "ecs_task" {
  role = aws_iam_role.ecs_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = [aws_s3_bucket.evidence.arn]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:GetObjectTagging"
        ]
        Resource = ["${aws_s3_bucket.evidence.arn}/private/*"]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:Encrypt", "kms:GenerateDataKey"]
        Resource = [aws_kms_key.data.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GetPublicKey"]
        Resource = [aws_kms_key.sync_encryption.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["kms:Sign", "kms:GetPublicKey"]
        Resource = [aws_kms_key.sync_receipt_signing.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["cognito-idp:AdminGetUser"]
        Resource = [aws_cognito_user_pool.main.arn]
      },
      {
        Effect = "Allow"
        Action = [
          "rekognition:CreateFaceLivenessSession",
          "rekognition:GetFaceLivenessSessionResults"
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["sts:AssumeRole"]
        Resource = [aws_iam_role.liveness_client.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
        Resource = [aws_sqs_queue.jobs.arn]
      }
    ]
  })
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.api_cpu)
  memory                   = tostring(var.api_memory)
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = "api"
    image     = var.api_image
    essential = true

    portMappings = [{
      containerPort = 3001
      hostPort      = 3001
      protocol      = "tcp"
    }]

    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "PORT", value = "3001" },
      { name = "DB_HOST", value = aws_db_instance.postgres.address },
      { name = "DB_PORT", value = "5432" },
      { name = "DB_NAME", value = aws_db_instance.postgres.db_name },
      { name = "DB_USER", value = aws_db_instance.postgres.username },
      { name = "DB_SSL", value = "true" },
      { name = "REDIS_URL", value = "rediss://${aws_elasticache_replication_group.redis.primary_endpoint_address}:6379" },
      { name = "AWS_REGION", value = var.aws_region },
      { name = "COGNITO_USER_POOL_ID", value = aws_cognito_user_pool.main.id },
      { name = "COGNITO_CLIENT_ID", value = aws_cognito_user_pool_client.web.id },
      { name = "PRIVATE_EVIDENCE_BUCKET", value = aws_s3_bucket.evidence.id },
      { name = "EVIDENCE_KMS_KEY_ID", value = aws_kms_key.data.arn },
      { name = "EVIDENCE_RETENTION_DAYS", value = tostring(var.evidence_retention_days) },
      { name = "EVIDENCE_MALWARE_SCAN_MODE", value = var.enable_guardduty_malware_protection ? "GUARDDUTY" : "DISABLED" },
      { name = "REQUIRE_MALWARE_SCAN", value = tostring(var.require_malware_scan) },
      { name = "LIVENESS_PROVIDER", value = upper(var.liveness_provider) },
      { name = "LIVENESS_CLIENT_ROLE_ARN", value = aws_iam_role.liveness_client.arn },
      { name = "LIVENESS_MAX_ATTEMPTS_PER_24H", value = tostring(var.liveness_max_attempts_per_24h) },
      { name = "SYNC_KEY_MODE", value = "AWS_KMS" },
      { name = "SYNC_ENCRYPTION_KMS_KEY_ID", value = aws_kms_key.sync_encryption.arn },
      { name = "SYNC_RECEIPT_SIGNING_KMS_KEY_ID", value = aws_kms_key.sync_receipt_signing.arn },
      { name = "SYNC_ENCRYPTION_KEY_PUBLIC_ID", value = "sync-encryption-v1" },
      { name = "SYNC_RECEIPT_SIGNING_KEY_PUBLIC_ID", value = "sync-receipt-v1" },
      { name = "SYNC_MAX_ENVELOPE_TTL_SECONDS", value = tostring(var.sync_max_envelope_ttl_seconds) },
      { name = "SYNC_MAX_CIPHERTEXT_BYTES", value = tostring(var.sync_max_ciphertext_bytes) },
      { name = "SYNC_MAX_BATCH_SIZE", value = tostring(var.sync_max_batch_size) },
      { name = "SYNC_BATCH_REQUESTS_PER_MINUTE", value = tostring(var.sync_batch_requests_per_minute) },
      { name = "REUNIFICATION_LOOKUP_KEY_VERSION", value = tostring(var.reunification_lookup_key_version) },
      { name = "REUNIFICATION_REQUEST_TTL_DAYS", value = tostring(var.reunification_request_ttl_days) },
      { name = "JOBS_QUEUE_URL", value = aws_sqs_queue.jobs.url },
      { name = "WEB_ORIGIN", value = var.domain_name != "" ? "https://${var.domain_name}" : "" },
      { name = "ALLOW_LEGACY_COMMAND_TOKEN", value = "false" },
      { name = "FEATURE_PUBLIC_SOS", value = "true" },
      { name = "FEATURE_OPERATIONAL_CENTER", value = "true" },
      { name = "FEATURE_AFFECTED_IDENTITY", value = tostring(var.feature_affected_identity) },
      { name = "FEATURE_LIVENESS", value = tostring(var.feature_liveness) },
      { name = "FEATURE_ASSISTANCE_MATCHING", value = tostring(var.feature_assistance_matching) },
      { name = "FEATURE_WHATSAPP", value = tostring(var.feature_whatsapp) },
      { name = "FEATURE_WEBRTC_RELAY", value = tostring(var.feature_webrtc_relay) },
      { name = "FEATURE_OPERATIONAL_LAYERS", value = tostring(var.feature_operational_layers) },
      { name = "FEATURE_SECURE_ENVELOPE", value = tostring(var.feature_secure_envelope) },
      { name = "FEATURE_REUNIFICATION", value = tostring(var.feature_reunification) }
    ]

    secrets = concat(
      [
        {
          name      = "DB_PASSWORD"
          valueFrom = "${aws_db_instance.postgres.master_user_secret[0].secret_arn}:password::"
        },
        {
          name      = "IDENTITY_HASH_SECRET"
          valueFrom = aws_secretsmanager_secret.identity_hash.arn
        }
      ],
      var.feature_reunification ? [
        {
          name      = "REUNIFICATION_LOOKUP_SECRET_B64URL"
          valueFrom = aws_secretsmanager_secret.reunification_lookup.arn
        }
      ] : []
    )

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.api.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "api"
      }
    }

    healthCheck = {
      command     = ["CMD-SHELL", "wget -qO- http://localhost:3001/api/v1/health >/dev/null || exit 1"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  network_configuration {
    subnets          = [for subnet in aws_subnet.app : subnet.id]
    security_groups  = [aws_security_group.api.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3001
  }

  health_check_grace_period_seconds = 90

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener_rule.cloudfront_only]
}

resource "aws_appautoscaling_target" "api" {
  max_capacity       = var.api_max_count
  min_capacity       = var.api_min_count
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.name}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.api.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 60
    scale_in_cooldown  = 120
    scale_out_cooldown = 30
  }
}

resource "aws_appautoscaling_policy" "api_memory" {
  name               = "${local.name}-api-memory"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.api.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageMemoryUtilization"
    }
    target_value       = 70
    scale_in_cooldown  = 120
    scale_out_cooldown = 30
  }
}
