variable "project_name" {
  type    = string
  default = "sos-eje-cafetero"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "vpc_cidr" {
  type    = string
  default = "10.42.0.0/16"
}

variable "az_count" {
  description = "Cantidad de AZ. Producción debe usar al menos 2."
  type        = number
  default     = 2
  validation {
    condition     = var.az_count >= 2 && var.az_count <= 3
    error_message = "az_count debe estar entre 2 y 3."
  }
}

variable "single_nat_gateway" {
  description = "true reduce costo en piloto, false crea NAT por AZ para producción."
  type        = bool
  default     = false
}

variable "api_image" {
  description = "URI inmutable de la imagen API en ECR, idealmente con tag SHA o digest."
  type        = string
}

variable "api_cpu" {
  type    = number
  default = 1024
}

variable "api_memory" {
  type    = number
  default = 2048
}

variable "api_desired_count" {
  type    = number
  default = 2
}

variable "api_min_count" {
  type    = number
  default = 2
}

variable "api_max_count" {
  type    = number
  default = 10
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}

variable "db_allocated_storage" {
  type    = number
  default = 100
}

variable "db_max_allocated_storage" {
  type    = number
  default = 500
}

variable "db_backup_retention_days" {
  type    = number
  default = 14
}

variable "deletion_protection" {
  type    = bool
  default = true
}

variable "redis_node_type" {
  type    = string
  default = "cache.t4g.small"
}

variable "evidence_retention_days" {
  description = "Retención técnica. Debe ajustarse a la política institucional antes de habilitar identidad real."
  type        = number
  default     = 90
}

variable "evidence_cors_origins" {
  description = "Origins autorizados para PUT presignado de evidencia. En producción usar el dominio exacto."
  type        = list(string)
  default     = ["*"]
}

variable "domain_name" {
  description = "Dominio opcional, por ejemplo sos.manizales.gov.co. Si queda vacío se usa el dominio CloudFront."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Hosted Zone ID para validar ACM y crear A/AAAA. Requerido si domain_name no está vacío."
  type        = string
  default     = ""
}

variable "alarm_email" {
  description = "Email opcional para suscripción SNS de alarmas; requiere confirmación del destinatario."
  type        = string
  default     = ""
}

variable "feature_affected_identity" {
  type    = bool
  default = false
}

variable "feature_liveness" {
  type    = bool
  default = false
}

variable "feature_assistance_matching" {
  type    = bool
  default = false
}

variable "feature_whatsapp" {
  type    = bool
  default = false
}

variable "feature_operational_layers" {
  type    = bool
  default = false
}

variable "feature_secure_envelope" {
  type    = bool
  default = false
}
