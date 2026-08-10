resource "random_uuid" "cognito_sms_external_id" {}

resource "aws_iam_role" "cognito_sms" {
  name = "${local.name}-cognito-sms"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "cognito-idp.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = {
          "sts:ExternalId"    = random_uuid.cognito_sms_external_id.result
          "aws:SourceAccount" = data.aws_caller_identity.current.account_id
        }
        ArnLike = {
          "aws:SourceArn" = "arn:aws:cognito-idp:${var.aws_region}:${data.aws_caller_identity.current.account_id}:userpool/*"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "cognito_sms" {
  name = "sns-publish-sms"
  role = aws_iam_role.cognito_sms.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sns:Publish"]
      Resource = "*"
    }]
  })
}

resource "aws_cognito_user_pool" "main" {
  name           = "${local.name}-users"
  user_pool_tier = "ESSENTIALS"

  username_attributes      = ["phone_number"]
  auto_verified_attributes = ["phone_number"]
  mfa_configuration        = "OFF"
  deletion_protection      = var.deletion_protection ? "ACTIVE" : "INACTIVE"

  sign_in_policy {
    allowed_first_auth_factors = ["SMS_OTP"]
  }

  sms_configuration {
    external_id    = random_uuid.cognito_sms_external_id.result
    sns_caller_arn = aws_iam_role.cognito_sms.arn
    sns_region     = var.aws_region
  }

  verification_message_template {
    default_email_option = "CONFIRM_WITH_CODE"
    sms_message          = "Tu código SOS Eje Cafetero es {####}. No lo compartas."
  }

  user_attribute_update_settings {
    attributes_require_verification_before_update = ["phone_number"]
  }

  depends_on = [aws_iam_role_policy.cognito_sms]
}

resource "aws_cognito_user_pool_client" "web" {
  name         = "${local.name}-web"
  user_pool_id = aws_cognito_user_pool.main.id

  generate_secret               = false
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
  explicit_auth_flows           = ["ALLOW_USER_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]

  access_token_validity  = 1
  id_token_validity      = 1
  refresh_token_validity = 30

  token_validity_units {
    access_token  = "hours"
    id_token      = "hours"
    refresh_token = "days"
  }
}
