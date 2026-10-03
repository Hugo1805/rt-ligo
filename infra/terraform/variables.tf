# General
variable "aws_region" {
  description = "AWS region for deployment"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Deployment environment name (e.g. production, staging)"
  type        = string
  default     = "production"
}

variable "app_name" {
  description = "Application name used for resource naming"
  type        = string
  default     = "wallet-cash-in"
}

# Network
variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "availability_zones" {
  description = "Availability zones for public and private subnets (at least 2 required)"
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b"]

  validation {
    condition     = length(var.availability_zones) >= 2
    error_message = "At least 2 availability zones are required for high availability."
  }
}

variable "public_subnet_cidrs" {
  description = "CIDR blocks for public subnets"
  type        = list(string)
  default     = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "private_subnet_cidrs" {
  description = "CIDR blocks for private subnets"
  type        = list(string)
  default     = ["10.0.10.0/24", "10.0.20.0/24"]
}

variable "single_nat_gateway" {
  description = "Set to true to use a single NAT Gateway across all AZs to save costs, false for one per AZ"
  type        = bool
  default     = true
}

# Application & ECS
variable "container_image" {
  description = "Docker image URI for the application container"
  type        = string
}

variable "container_port" {
  description = "Port on which the application container listens"
  type        = number
  default     = 3000
}

variable "app_desired_count" {
  description = "Desired number of ECS tasks (minimum 2)"
  type        = number
  default     = 2

  validation {
    condition     = var.app_desired_count >= 2
    error_message = "app_desired_count must be at least 2 to ensure high availability and multi-pod idempotency."
  }
}

variable "ecs_cpu" {
  description = "Fargate task CPU units (256 = 0.25 vCPU, 512 = 0.5 vCPU, 1024 = 1 vCPU)"
  type        = number
  default     = 256
}

variable "ecs_memory" {
  description = "Fargate task memory in MiB (512, 1024, 2048, etc.)"
  type        = number
  default     = 512
}

variable "acm_certificate_arn" {
  description = "ARN of ACM Certificate for ALB HTTPS listener (optional; leave empty for HTTP-only)"
  type        = string
  default     = ""
}

variable "log_retention_days" {
  description = "Retention period in days for CloudWatch application logs"
  type        = number
  default     = 30
}

# Runtime application configuration (design §13)
variable "provider_mode" {
  description = "Payment provider mode ('fake' or 'http')"
  type        = string
  default     = "fake"
}

variable "provider_base_url" {
  description = "Payment provider base URL (required when provider_mode is 'http')"
  type        = string
  default     = ""
}

variable "provider_timeout_ms" {
  description = "Timeout in ms for payment provider calls"
  type        = number
  default     = 3000
}

variable "provider_max_retries" {
  description = "Maximum technical retries for payment provider calls"
  type        = number
  default     = 2
}

variable "lock_ttl_ms" {
  description = "Lock TTL in ms for Redis fast idempotency barrier"
  type        = number
  default     = 15000
}

variable "cash_in_max_amount" {
  description = "Maximum cash-in amount per operation in PEN"
  type        = number
  default     = 10000
}

variable "reconcile_interval_ms" {
  description = "Reconciliation loop interval in ms"
  type        = number
  default     = 10000
}

variable "reconcile_stale_ms" {
  description = "Minimum age in ms for an operation to be considered stale and eligible for reconciliation"
  type        = number
  default     = 30000
}

variable "reconcile_max_attempts" {
  description = "Maximum reconciliation attempts before marking alert"
  type        = number
  default     = 5
}

variable "webhook_tolerance_s" {
  description = "Webhook timestamp tolerance in seconds"
  type        = number
  default     = 300
}

variable "log_level" {
  description = "Application logging level"
  type        = string
  default     = "info"
}

# RDS PostgreSQL
variable "db_instance_class" {
  description = "Instance class for RDS PostgreSQL"
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  description = "Allocated storage in GB for RDS PostgreSQL"
  type        = number
  default     = 20
}

variable "db_name" {
  description = "Database name for PostgreSQL"
  type        = string
  default     = "wallet_cash_in"
}

variable "db_username" {
  description = "Master username for PostgreSQL"
  type        = string
  default     = "dbadmin"
}

variable "db_multi_az" {
  description = "Enable Multi-AZ deployment for RDS PostgreSQL"
  type        = bool
  default     = false
}

variable "db_deletion_protection" {
  description = "Enable deletion protection for RDS PostgreSQL"
  type        = bool
  default     = false
}

variable "db_skip_final_snapshot" {
  description = "Skip final snapshot when destroying RDS PostgreSQL"
  type        = bool
  default     = true
}

variable "postgres_version" {
  description = "PostgreSQL engine version"
  type        = string
  default     = "16.4"
}

# ElastiCache Redis
variable "redis_node_type" {
  description = "Node type for ElastiCache Redis replication group"
  type        = string
  default     = "cache.t4g.micro"
}

variable "redis_num_cache_clusters" {
  description = "Number of cache clusters for ElastiCache Redis (minimum 2 for multi-az replication)"
  type        = number
  default     = 2
}

variable "redis_version" {
  description = "Redis engine version"
  type        = string
  default     = "7.1"
}
