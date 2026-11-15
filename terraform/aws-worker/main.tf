terraform {
  required_version = ">= 1.5.0"
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

data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64"
}

resource "aws_security_group" "worker" {
  name_prefix = "${var.name_prefix}-worker-"
  description = "Private ATH IDE execution workers; ingress only from the internal NLB"
  vpc_id      = var.vpc_id

  egress {
    description = "Outbound access via the supplied private-subnet egress path"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(var.tags, { Application = "ath-ide", Role = "execution-worker" })
}

resource "aws_security_group" "internal_nlb" {
  name_prefix = "${var.name_prefix}-worker-nlb-"
  description = "Internal execution-worker NLB; only the API security group may connect"
  vpc_id      = var.vpc_id

  ingress {
    description     = "API to private execution worker"
    from_port       = 8081
    to_port         = 8081
    protocol        = "tcp"
    security_groups = [var.api_security_group_id]
  }

  egress {
    description     = "Forward worker traffic"
    from_port       = 8081
    to_port         = 8081
    protocol        = "tcp"
    security_groups = [aws_security_group.worker.id]
  }

  tags = merge(var.tags, { Application = "ath-ide", Role = "internal-worker-lb" })
}

resource "aws_vpc_security_group_ingress_rule" "worker_from_nlb" {
  security_group_id            = aws_security_group.worker.id
  referenced_security_group_id = aws_security_group.internal_nlb.id
  description                  = "Only the internal NLB may reach the worker HTTP port"
  from_port                    = 8081
  to_port                      = 8081
  ip_protocol                  = "tcp"
}

resource "aws_iam_role" "worker" {
  name_prefix = "${var.name_prefix}-worker-"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = merge(var.tags, { Application = "ath-ide", Role = "execution-worker" })
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.worker.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "worker" {
  name = "${var.name_prefix}-worker-runtime"
  role = aws_iam_role.worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = concat([
      {
        Sid      = "ReadOnlyWorkerBootstrapSecret"
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue"]
        Resource = var.worker_secret_arn
      },
      {
        Sid      = "ReadWriteWorkspaceSnapshots"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${var.workspace_bucket_arn}/workspaces/*"
      }
      ], var.kms_key_arn == "" ? [] : [{
        Sid      = "UseWorkspaceSnapshotKmsKey"
        Effect   = "Allow"
        Action   = ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"]
        Resource = var.kms_key_arn
    }])
  })
}

resource "aws_iam_instance_profile" "worker" {
  name_prefix = "${var.name_prefix}-worker-"
  role        = aws_iam_role.worker.name
}

resource "aws_lb" "worker" {
  name                             = substr("${var.name_prefix}-worker", 0, 32)
  internal                         = true
  load_balancer_type               = "network"
  ip_address_type                  = "ipv4"
  subnets                          = var.private_subnet_ids
  security_groups                  = [aws_security_group.internal_nlb.id]
  enable_cross_zone_load_balancing = true

  tags = merge(var.tags, { Application = "ath-ide", Role = "execution-worker" })
}

resource "aws_lb_target_group" "worker" {
  name        = substr("${var.name_prefix}-worker-tg", 0, 32)
  port        = 8081
  protocol    = "TCP"
  target_type = "instance"
  vpc_id      = var.vpc_id

  health_check {
    enabled             = true
    protocol            = "HTTP"
    port                = "traffic-port"
    path                = "/healthz"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 30
  }

  tags = merge(var.tags, { Application = "ath-ide", Role = "execution-worker" })
}

resource "aws_lb_listener" "worker" {
  load_balancer_arn = aws_lb.worker.arn
  port              = 8081
  protocol          = "TCP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.worker.arn
  }
}

resource "aws_launch_template" "worker" {
  name_prefix            = "${var.name_prefix}-worker-"
  image_id               = data.aws_ssm_parameter.al2023_ami.value
  instance_type          = var.instance_type
  update_default_version = true

  iam_instance_profile {
    name = aws_iam_instance_profile.worker.name
  }

  vpc_security_group_ids = [aws_security_group.worker.id]

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "disabled"
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = var.root_volume_size_gib
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  user_data = base64encode(templatefile("${path.module}/user_data.sh.tftpl", {
    aws_region        = var.aws_region
    repository_url    = var.repository_url
    repository_branch = var.repository_branch
    worker_secret_arn = var.worker_secret_arn
    workspace_bucket  = var.workspace_bucket_name
    kms_key_id        = var.kms_key_arn
    workspace_image   = var.workspace_image
  }))

  tag_specifications {
    resource_type = "instance"
    tags = merge(var.tags, {
      Name        = "${var.name_prefix}-execution-worker"
      Application = "ath-ide"
      Role        = "execution-worker"
    })
  }

  tags = merge(var.tags, { Application = "ath-ide", Role = "execution-worker" })
}

resource "aws_autoscaling_group" "worker" {
  name                      = "${var.name_prefix}-execution-workers"
  min_size                  = var.min_size
  desired_capacity          = var.desired_capacity
  max_size                  = var.max_size
  vpc_zone_identifier       = var.private_subnet_ids
  target_group_arns         = [aws_lb_target_group.worker.arn]
  health_check_type         = "ELB"
  health_check_grace_period = 600
  force_delete              = false

  launch_template {
    id      = aws_launch_template.worker.id
    version = "$Latest"
  }

  instance_refresh {
    strategy = "Rolling"
    preferences {
      min_healthy_percentage = 50
      instance_warmup        = 600
    }
  }

  tag {
    key                 = "Application"
    value               = "ath-ide"
    propagate_at_launch = true
  }
  tag {
    key                 = "Role"
    value               = "execution-worker"
    propagate_at_launch = true
  }
}

resource "aws_autoscaling_policy" "worker_cpu" {
  name                   = "${var.name_prefix}-worker-cpu-target"
  autoscaling_group_name = aws_autoscaling_group.worker.name
  policy_type            = "TargetTrackingScaling"

  target_tracking_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ASGAverageCPUUtilization"
    }
    target_value = var.target_cpu_utilization
  }
}
