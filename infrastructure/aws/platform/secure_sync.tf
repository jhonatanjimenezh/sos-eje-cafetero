resource "aws_kms_key" "sync_encryption" {
  description              = "${local.name} SecureEnvelope RSA-3072 encryption key"
  customer_master_key_spec = "RSA_3072"
  key_usage                = "ENCRYPT_DECRYPT"
  deletion_window_in_days  = 30
  enable_key_rotation      = false
}

resource "aws_kms_alias" "sync_encryption" {
  name          = "alias/${local.name}-sync-encryption"
  target_key_id = aws_kms_key.sync_encryption.key_id
}

resource "aws_kms_key" "sync_receipt_signing" {
  description              = "${local.name} SecureEnvelope RSA-3072 receipt signing key"
  customer_master_key_spec = "RSA_3072"
  key_usage                = "SIGN_VERIFY"
  deletion_window_in_days  = 30
  enable_key_rotation      = false
}

resource "aws_kms_alias" "sync_receipt_signing" {
  name          = "alias/${local.name}-sync-receipt-signing"
  target_key_id = aws_kms_key.sync_receipt_signing.key_id
}
