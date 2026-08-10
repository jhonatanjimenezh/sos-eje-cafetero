output "state_bucket" {
  value       = aws_s3_bucket.tfstate.id
  description = "Bucket para remote Terraform state."
}

output "state_kms_key_arn" {
  value       = aws_kms_key.bootstrap.arn
  description = "KMS key del state/ECR."
}

output "ecr_repository_url" {
  value       = aws_ecr_repository.api.repository_url
  description = "Repositorio ECR donde publicar la imagen del API."
}

output "aws_account_id" {
  value = data.aws_caller_identity.current.account_id
}
