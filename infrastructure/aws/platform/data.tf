resource "aws_kms_key" "data" {
  description             = "${local.name} application data encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "data" {
  name          = "alias/${local.name}-data"
  target_key_id = aws_kms_key.data.key_id
}

resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-db"
  subnet_ids = [for subnet in aws_subnet.data : subnet.id]
}

resource "aws_db_parameter_group" "postgres" {
  name   = "${local.name}-postgres16"
  family = "postgres16"

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }
}

resource "aws_db_instance" "postgres" {
  identifier = "${local.name}-postgres"

  engine         = "postgres"
  instance_class = var.db_instance_class
  db_name        = "sos"
  username       = "sosadmin"
  port           = 5432

  allocated_storage     = var.db_allocated_storage
  max_allocated_storage = var.db_max_allocated_storage
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.data.arn

  manage_master_user_password   = true
  master_user_secret_kms_key_id = aws_kms_key.data.arn

  multi_az               = true
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.postgres.name
  publicly_accessible    = false

  backup_retention_period = var.db_backup_retention_days
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:05:00-sun:06:00"
  copy_tags_to_snapshot   = true

  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.data.arn
  enabled_cloudwatch_logs_exports = ["postgresql"]
  auto_minor_version_upgrade      = true
  deletion_protection             = var.deletion_protection
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${local.name}-postgres-final"

  lifecycle {
    prevent_destroy = false
  }
}

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name}-redis"
  subnet_ids = [for subnet in aws_subnet.data : subnet.id]
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id = "${local.name}-redis"
  description          = "Redis for rate limits, transient state and coordination"

  engine                     = "redis"
  node_type                  = var.redis_node_type
  port                       = 6379
  num_cache_clusters         = 2
  automatic_failover_enabled = true
  multi_az_enabled           = true

  subnet_group_name  = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  kms_key_id                 = aws_kms_key.data.arn

  snapshot_retention_limit = 7
  snapshot_window          = "04:00-05:00"
  maintenance_window       = "sun:06:00-sun:07:00"
  apply_immediately        = false
}
