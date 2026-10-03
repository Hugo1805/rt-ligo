output "alb_dns_name" {
  description = "DNS name of the public Application Load Balancer"
  value       = aws_lb.alb.dns_name
}

output "rds_endpoint" {
  description = "Connection endpoint of the RDS PostgreSQL instance"
  value       = aws_db_instance.postgres.endpoint
}

output "rds_address" {
  description = "Hostname address of the RDS PostgreSQL instance"
  value       = aws_db_instance.postgres.address
}

output "redis_endpoint" {
  description = "Primary endpoint address of the ElastiCache Redis replication group"
  value       = aws_elasticache_replication_group.redis.primary_endpoint_address
}

output "redis_port" {
  description = "Port number of the ElastiCache Redis replication group"
  value       = aws_elasticache_replication_group.redis.port
}

output "database_url_secret_arn" {
  description = "ARN of the Secrets Manager secret for DATABASE_URL"
  value       = aws_secretsmanager_secret.database_url.arn
}

output "webhook_secret_arn" {
  description = "ARN of the Secrets Manager secret for WEBHOOK_SECRET"
  value       = aws_secretsmanager_secret.webhook_secret.arn
}

output "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  value       = aws_ecs_cluster.main.name
}

output "ecs_service_name" {
  description = "Name of the ECS service"
  value       = aws_ecs_service.app.name
}
