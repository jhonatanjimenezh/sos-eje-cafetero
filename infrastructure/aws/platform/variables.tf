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
  validation {
    condition     = var.evidence_retention_days >= 1 && var.evidence_retention_days <= 3650
    error_message = "evidence_retention_days debe estar entre 1 y 3650."
  }
}

variable "evidence_cors_origins" {
  description = "Origins autorizados para PUT presignado de evidencia. En producción usar el dominio exacto."
  type        = list(string)
  default     = ["*"]
}

variable "enable_guardduty_malware_protection" {
  description = "Activa GuardDuty Malware Protection for S3 para objetos de evidencia nuevos."
  type        = bool
  default     = true
}

variable "require_malware_scan" {
  description = "Impide enviar un expediente a revisión mientras la evidencia requerida no tenga resultado antimalware limpio."
  type        = bool
  default     = true
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

variable "liveness_provider" {
  description = "Proveedor de prueba de presencia. REKOGNITION en AWS; MANUAL conserva el reto de video como fallback no biométrico."
  type        = string
  default     = "REKOGNITION"
  validation {
    condition     = contains(["REKOGNITION", "MANUAL"], upper(var.liveness_provider))
    error_message = "liveness_provider debe ser REKOGNITION o MANUAL."
  }
}

variable "liveness_max_attempts_per_24h" {
  description = "Límite antifraude de sesiones de liveness por expediente y ventana de 24 horas."
  type        = number
  default     = 3
  validation {
    condition     = var.liveness_max_attempts_per_24h >= 1 && var.liveness_max_attempts_per_24h <= 10
    error_message = "liveness_max_attempts_per_24h debe estar entre 1 y 10."
  }
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
