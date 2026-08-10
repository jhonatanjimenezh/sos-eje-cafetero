resource "aws_iam_role" "liveness_client" {
  name = "${local.name}-liveness-client"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        AWS = aws_iam_role.ecs_task.arn
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "liveness_client" {
  name = "start-face-liveness-session"
  role = aws_iam_role.liveness_client.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["rekognition:StartFaceLivenessSession"]
      Resource = "*"
    }]
  })
}

resource "aws_iam_role" "guardduty_malware" {
  count = var.enable_guardduty_malware_protection ? 1 : 0
  name  = "${local.name}-guardduty-malware"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "malware-protection-plan.guardduty.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "guardduty_malware" {
  count = var.enable_guardduty_malware_protection ? 1 : 0
  name  = "scan-private-evidence"
  role  = aws_iam_role.guardduty_malware[0].id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "EventBridgeManagedRule"
        Effect = "Allow"
        Action = [
          "events:PutRule",
          "events:DeleteRule",
          "events:PutTargets",
          "events:RemoveTargets"
        ]
        Resource = "arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*"
        Condition = {
          StringEquals = {
            "events:ManagedBy" = "malware-protection-plan.guardduty.amazonaws.com"
          }
        }
      },
      {
        Sid      = "EventBridgeRead"
        Effect   = "Allow"
        Action   = ["events:DescribeRule", "events:ListTargetsByRule"]
        Resource = "arn:aws:events:${var.aws_region}:${data.aws_caller_identity.current.account_id}:rule/DO-NOT-DELETE-AmazonGuardDutyMalwareProtectionS3*"
      },
      {
        Sid    = "BucketConfiguration"
        Effect = "Allow"
        Action = [
          "s3:GetBucketNotification",
          "s3:PutBucketNotification",
          "s3:ListBucket"
        ]
        Resource = aws_s3_bucket.evidence.arn
      },
      {
        Sid      = "ValidationObject"
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.evidence.arn}/malware-protection-resource-validation-object"
      },
      {
        Sid    = "ReadAndTagEvidence"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:GetObjectVersion",
          "s3:GetObjectTagging",
          "s3:GetObjectVersionTagging",
          "s3:PutObjectTagging",
          "s3:PutObjectVersionTagging"
        ]
        Resource = "${aws_s3_bucket.evidence.arn}/private/affected/*"
      },
      {
        Sid      = "DecryptEvidence"
        Effect   = "Allow"
        Action   = ["kms:Decrypt", "kms:GenerateDataKey"]
        Resource = aws_kms_key.data.arn
        Condition = {
          StringLike = {
            "kms:ViaService" = "s3.${var.aws_region}.amazonaws.com"
          }
        }
      }
    ]
  })
}

resource "aws_guardduty_malware_protection_plan" "evidence" {
  count = var.enable_guardduty_malware_protection ? 1 : 0

  role = aws_iam_role.guardduty_malware[0].arn

  protected_resource {
    s3_bucket {
      bucket_name     = aws_s3_bucket.evidence.id
      object_prefixes = ["private/affected/"]
    }
  }

  actions {
    tagging {
      status = "ENABLED"
    }
  }

  depends_on = [aws_iam_role_policy.guardduty_malware]
}
