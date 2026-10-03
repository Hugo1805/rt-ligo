resource "aws_elasticache_subnet_group" "redis" {
  name        = "${var.app_name}-${var.environment}-redis-subnet-group"
  description = "Subnet group for ElastiCache Redis in private subnets"
  subnet_ids  = aws_subnet.private[*].id

  tags = {
    Name = "${var.app_name}-${var.environment}-redis-subnet-group"
  }
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "${var.app_name}-${var.environment}-redis"
  description                = "ElastiCache Redis replication group for fast idempotency locking"
  engine                     = "redis"
  engine_version             = var.redis_version
  node_type                  = var.redis_node_type
  num_cache_clusters         = var.redis_num_cache_clusters
  port                       = 6379
  subnet_group_name          = aws_elasticache_subnet_group.redis.name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  automatic_failover_enabled = var.redis_num_cache_clusters > 1
  auto_minor_version_upgrade = true

  tags = {
    Name = "${var.app_name}-${var.environment}-redis"
  }
}
