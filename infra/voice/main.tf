# SkyMP Voice Chat Infrastructure — AWS (Cost-Optimized)
#
# Architecture:
#   - ECS Fargate Spot for LiveKit server + Voice Agent (pay per second)
#   - ElastiCache Serverless for Redis (pay per ECU-hour, ~$2.50/mo baseline)
#   - Single ALB for LiveKit WebSocket signaling (shared with game if desired)
#   - VPC with public + private subnets
#
# Estimated monthly cost at 500 players:
#   LiveKit (Fargate Spot, 2 vCPU / 4GB):  ~$24/mo
#   Voice Agent (Fargate Spot, 0.5 vCPU / 1GB): ~$6/mo
#   ElastiCache Serverless Redis: ~$3/mo
#   ALB: ~$16/mo (fixed) + ~$5/mo (LCU)
#   NAT Gateway: ~$32/mo (can eliminate with public subnets)
#   Total: ~$54-86/mo for full auto-scaling voice infrastructure
#
# For even cheaper (dev/small server):
#   Single EC2 t3.small Spot instance running all three in Docker: ~$5/mo

terraform {
  required_version = ">= 1.5"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------

variable "aws_region" {
  default = "us-east-1"
}

variable "environment" {
  default = "production"
}

variable "vpc_id" {
  description = "Existing VPC ID (use the same VPC as the game server)"
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnet IDs for ECS tasks"
  type        = list(string)
}

variable "public_subnet_ids" {
  description = "Public subnet IDs for ALB"
  type        = list(string)
}

variable "livekit_api_key" {
  description = "LiveKit API key"
  type        = string
  sensitive   = true
}

variable "livekit_api_secret" {
  description = "LiveKit API secret"
  type        = string
  sensitive   = true
}

variable "game_server_security_group_id" {
  description = "SG of the game server (for Redis access)"
  type        = string
}

variable "voice_range" {
  description = "Voice proximity range in game units"
  default     = 4000
}

variable "room_prefix" {
  default = "eruvos"
}

# ---------------------------------------------------------------------------
# ElastiCache Serverless (Redis) — auto-scales, pay per use
# ---------------------------------------------------------------------------

resource "aws_elasticache_serverless_cache" "voice_redis" {
  engine = "redis"
  name   = "${var.room_prefix}-voice-redis"

  cache_usage_limits {
    data_storage {
      maximum = 1 # 1 GB max (position data is tiny)
      unit    = "GB"
    }
    ecpu_per_second {
      maximum = 1000 # More than enough for position pub/sub
    }
  }

  subnet_ids         = var.private_subnet_ids
  security_group_ids = [aws_security_group.redis.id]

  tags = {
    Environment = var.environment
    Service     = "voice-chat"
  }
}

resource "aws_security_group" "redis" {
  name_prefix = "${var.room_prefix}-voice-redis-"
  vpc_id      = var.vpc_id

  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [
      aws_security_group.voice_services.id,
      var.game_server_security_group_id
    ]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---------------------------------------------------------------------------
# Security Group for Voice Services (LiveKit + Voice Agent)
# ---------------------------------------------------------------------------

resource "aws_security_group" "voice_services" {
  name_prefix = "${var.room_prefix}-voice-svc-"
  vpc_id      = var.vpc_id

  # LiveKit WebSocket signaling (via ALB)
  ingress {
    from_port   = 7880
    to_port     = 7880
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # LiveKit WebRTC UDP (ICE candidates)
  # Range for TURN/STUN relay
  ingress {
    from_port   = 50000
    to_port     = 60000
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  # LiveKit WebRTC TCP fallback
  ingress {
    from_port   = 7881
    to_port     = 7881
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---------------------------------------------------------------------------
# ECS Cluster
# ---------------------------------------------------------------------------

resource "aws_ecs_cluster" "voice" {
  name = "${var.room_prefix}-voice"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "voice" {
  cluster_name = aws_ecs_cluster.voice.name

  capacity_providers = ["FARGATE_SPOT", "FARGATE"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 4 # 80% Spot
    base              = 0
  }

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1 # 20% On-demand (fallback)
    base              = 1 # At least 1 on-demand for stability
  }
}

# ---------------------------------------------------------------------------
# IAM
# ---------------------------------------------------------------------------

resource "aws_iam_role" "ecs_task_execution" {
  name_prefix = "${var.room_prefix}-voice-exec-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "ecs_task" {
  name_prefix = "${var.room_prefix}-voice-task-"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

# ---------------------------------------------------------------------------
# CloudWatch Log Groups
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "livekit" {
  name              = "/ecs/${var.room_prefix}-livekit"
  retention_in_days = 7
}

resource "aws_cloudwatch_log_group" "voice_agent" {
  name              = "/ecs/${var.room_prefix}-voice-agent"
  retention_in_days = 7
}

# ---------------------------------------------------------------------------
# LiveKit Server — ECS Fargate Task
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "livekit" {
  family                   = "${var.room_prefix}-livekit"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "2048" # 2 vCPU
  memory                   = "4096" # 4 GB
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = "livekit"
    image     = "livekit/livekit-server:latest"
    essential = true

    portMappings = [
      { containerPort = 7880, protocol = "tcp" },  # WebSocket
      { containerPort = 7881, protocol = "tcp" },  # WebRTC TCP
      { containerPort = 50000, protocol = "udp" }, # WebRTC UDP range start
    ]

    environment = [
      { name = "LIVEKIT_KEYS", value = "${var.livekit_api_key}: ${var.livekit_api_secret}" },
    ]

    # LiveKit config via LIVEKIT_CONFIG env var
    command = ["--config-body", jsonencode({
      port      = 7880
      rtc = {
        port_range_start = 50000
        port_range_end   = 60000
        tcp_port         = 7881
        use_external_ip  = true
      }
      redis = {
        address = aws_elasticache_serverless_cache.voice_redis.endpoint[0].address
      }
      room = {
        auto_create = true
        max_participants = 600
      }
      audio = {
        active_speaker_weight = 0.9
      }
      logging = {
        level = "info"
      }
    })]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.livekit.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "livekit"
      }
    }
  }])
}

resource "aws_ecs_service" "livekit" {
  name            = "${var.room_prefix}-livekit"
  cluster         = aws_ecs_cluster.voice.id
  task_definition = aws_ecs_task_definition.livekit.arn
  desired_count   = 1

  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
    base              = 1
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.voice_services.id]
    assign_public_ip = true # Required for WebRTC ICE
  }

  # Allow Fargate Spot interruptions without killing the service
  deployment_configuration {
    maximum_percent         = 200
    minimum_healthy_percent = 100
  }
}

# ---------------------------------------------------------------------------
# Voice Agent — ECS Fargate Task
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "voice_agent" {
  family                   = "${var.room_prefix}-voice-agent"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"  # 0.5 vCPU
  memory                   = "1024" # 1 GB
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name      = "voice-agent"
    image     = "${var.room_prefix}/voice-agent:latest"
    essential = true

    environment = [
      { name = "LIVEKIT_HOST", value = "ws://localhost:7880" },
      { name = "LIVEKIT_API_KEY", value = var.livekit_api_key },
      { name = "LIVEKIT_API_SECRET", value = var.livekit_api_secret },
      { name = "REDIS_ADDR", value = "${aws_elasticache_serverless_cache.voice_redis.endpoint[0].address}:6379" },
      { name = "ROOM_PREFIX", value = var.room_prefix },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.voice_agent.name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "voice-agent"
      }
    }
  }])
}

resource "aws_ecs_service" "voice_agent" {
  name            = "${var.room_prefix}-voice-agent"
  cluster         = aws_ecs_cluster.voice.id
  task_definition = aws_ecs_task_definition.voice_agent.arn
  desired_count   = 1

  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    weight            = 1
    base              = 1
  }

  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.voice_services.id]
  }
}

# ---------------------------------------------------------------------------
# Auto Scaling — scale LiveKit based on participant count
# ---------------------------------------------------------------------------

resource "aws_appautoscaling_target" "livekit" {
  max_capacity       = 4
  min_capacity       = 1
  resource_id        = "service/${aws_ecs_cluster.voice.name}/${aws_ecs_service.livekit.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "livekit_cpu" {
  name               = "${var.room_prefix}-livekit-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.livekit.resource_id
  scalable_dimension = aws_appautoscaling_target.livekit.scalable_dimension
  service_namespace  = aws_appautoscaling_target.livekit.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 60.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

output "livekit_ws_endpoint" {
  description = "LiveKit WebSocket endpoint for clients"
  value       = "wss://<your-domain>:7880"
}

output "redis_endpoint" {
  description = "Redis endpoint for game server position sync"
  value       = aws_elasticache_serverless_cache.voice_redis.endpoint[0].address
}

output "ecs_cluster" {
  value = aws_ecs_cluster.voice.name
}
