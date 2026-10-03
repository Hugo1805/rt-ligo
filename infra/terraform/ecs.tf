resource "aws_ecs_cluster" "main" {
  name = "${var.app_name}-${var.environment}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = {
    Name = "${var.app_name}-${var.environment}-cluster"
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = "${var.app_name}-${var.environment}"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.ecs_cpu)
  memory                   = tostring(var.ecs_memory)
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "cash-in-app"
      image     = var.container_image
      essential = true

      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = var.container_port
          protocol      = "tcp"
        }
      ]

      environment = [
        {
          name  = "PORT"
          value = tostring(var.container_port)
        },
        {
          name  = "NODE_ENV"
          value = "production"
        },
        {
          name  = "LOG_LEVEL"
          value = var.log_level
        },
        {
          name  = "PROVIDER_MODE"
          value = var.provider_mode
        },
        {
          name  = "PROVIDER_BASE_URL"
          value = var.provider_base_url
        },
        {
          name  = "REDIS_URL"
          value = "rediss://${aws_elasticache_replication_group.redis.primary_endpoint_address}:${aws_elasticache_replication_group.redis.port}"
        },
        {
          name  = "PROVIDER_TIMEOUT_MS"
          value = tostring(var.provider_timeout_ms)
        },
        {
          name  = "PROVIDER_MAX_RETRIES"
          value = tostring(var.provider_max_retries)
        },
        {
          name  = "LOCK_TTL_MS"
          value = tostring(var.lock_ttl_ms)
        },
        {
          name  = "CASH_IN_MAX_AMOUNT"
          value = tostring(var.cash_in_max_amount)
        },
        {
          name  = "RECONCILE_INTERVAL_MS"
          value = tostring(var.reconcile_interval_ms)
        },
        {
          name  = "RECONCILE_STALE_MS"
          value = tostring(var.reconcile_stale_ms)
        },
        {
          name  = "RECONCILE_MAX_ATTEMPTS"
          value = tostring(var.reconcile_max_attempts)
        },
        {
          name  = "WEBHOOK_TOLERANCE_S"
          value = tostring(var.webhook_tolerance_s)
        }
      ]

      secrets = [
        {
          name      = "DATABASE_URL"
          valueFrom = aws_secretsmanager_secret.database_url.arn
        },
        {
          name      = "WEBHOOK_SECRET"
          valueFrom = aws_secretsmanager_secret.webhook_secret.arn
        }
      ]

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  tags = {
    Name = "${var.app_name}-${var.environment}-task"
  }
}

resource "aws_ecs_service" "app" {
  name                               = "${var.app_name}-${var.environment}-service"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.app.arn
  desired_count                      = var.app_desired_count
  launch_type                        = "FARGATE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "cash-in-app"
    container_port   = var.container_port
  }

  depends_on = [
    aws_lb_listener.http
  ]

  tags = {
    Name = "${var.app_name}-${var.environment}-service"
  }
}
