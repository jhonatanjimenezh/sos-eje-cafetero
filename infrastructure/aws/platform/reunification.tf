variable "feature_reunification" {
  description = "Habilita reencuentro unilateral. Mantener false hasta cargar el secreto de lookup y superar #22."
  type        = bool
  default     = false
}

variable "reunification_lookup_key_version" {
  description = "Versión pública del secreto HMAC activo. Incrementar al rotar."
  type        = number
  default     = 1
  validation {
    condition     = var.reunification_lookup_key_version >= 1 && floor(var.reunification_lookup_key_version) == var.reunification_lookup_key_version
    error_message = "reunification_lookup_key_version debe ser un entero >= 1."
  }
}

variable "reunification_request_ttl_days" {
  description = "TTL de solicitudes de reencuentro. Minimización de datos: 1-30 días."
  type        = number
  default     = 14
  validation {
    condition     = var.reunification_request_ttl_days >= 1 && var.reunification_request_ttl_days <= 30
    error_message = "reunification_request_ttl_days debe estar entre 1 y 30."
  }
}

# Terraform crea únicamente el contenedor/custodia del secreto. NO crea una
# aws_secretsmanager_secret_version: el valor HMAC debe cargarse fuera de Terraform
# para que nunca aparezca en tfstate, plan, PR o variables de CI.
resource "aws_secretsmanager_secret" "reunification_lookup" {
  name                    = "${local.name}/reunification-lookup"
  kms_key_id              = aws_kms_key.data.arn
  recovery_window_in_days = 30

  lifecycle {
    prevent_destroy = true
  }
}

output "reunification_lookup_secret_arn" {
  value     = aws_secretsmanager_secret.reunification_lookup.arn
  sensitive = true
}

output "feature_reunification" {
  value = var.feature_reunification
}
