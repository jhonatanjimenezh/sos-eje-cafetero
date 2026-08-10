variable "project_name" {
  description = "Nombre corto usado en recursos AWS."
  type        = string
  default     = "sos-eje-cafetero"
}

variable "aws_region" {
  description = "Región primaria AWS."
  type        = string
  default     = "us-east-1"
}

variable "state_bucket_prefix" {
  description = "Prefijo globalmente único del bucket de Terraform state. Se agrega un sufijo aleatorio."
  type        = string
  default     = "sos-eje-cafetero-tfstate"
}
