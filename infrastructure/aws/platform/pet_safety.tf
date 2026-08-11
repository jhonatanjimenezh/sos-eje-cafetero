# Mascotas Seguras intentionally keeps secret VALUES outside Terraform.
# These resources create only KMS-backed custody containers. Loading a secret value
# via aws_secretsmanager_secret_version here would place sensitive material in tfstate.

resource "aws_secretsmanager_secret" "pet_profile_encryption" {
  name                    = "${local.name}/pet-profile-encryption"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret" "pet_identity_hash" {
  name                    = "${local.name}/pet-identity-hash"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }
}

output "pet_profile_encryption_secret_arn" {
  description = "Contenedor donde operaciones debe cargar PET_PROFILE_ENCRYPTION_SECRET_B64URL fuera de Terraform."
  value       = aws_secretsmanager_secret.pet_profile_encryption.arn
  sensitive   = true
}

output "pet_identity_hash_secret_arn" {
  description = "Contenedor donde operaciones debe cargar PET_IDENTITY_HASH_SECRET_B64URL fuera de Terraform."
  value       = aws_secretsmanager_secret.pet_identity_hash.arn
  sensitive   = true
}
