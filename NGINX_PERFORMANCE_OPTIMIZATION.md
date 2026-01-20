# Nginx 代理性能优化指南

## 问题
直接访问 unpkg 和 packager 服务很快，但通过 Nginx 代理后变慢。

## 原因分析

### 1. 每次请求都建立新连接
- 默认情况下，Nginx 不会保持与上游服务的连接
- 每次请求都要经历 TCP 三次握手

### 2. 没有缓存
- 相同的资源每次都要从上游获取
- npm 包文件实际上很少变化，非常适合缓存

### 3. DNS 解析开销
- 如果使用域名，每次可能都要解析

### 4. 代理缓冲区设置不当
- 默认配置可能不是最优的

## 优化方案

### 方案一：使用优化配置文件（推荐）

已创建 `nginx-optimized.conf`，包含所有优化。

#### 关键优化点：

1. **upstream + keepalive（连接复用）**
```nginx
upstream unpkg_backend {
    server 10.4.5.136:3001;
    keepalive 32;  # 保持 32 个长连接
}
```

2. **proxy_cache（缓存）**
```nginx
proxy_cache unpkg_cache;
proxy_cache_valid 200 304 7d;  # 缓存 7 天
```

3. **HTTP/1.1 + Connection ""（关键）**
```nginx
proxy_http_version 1.1;
proxy_set_header Connection "";
```

### 方案二：分步优化

#### 步骤 1: 创建缓存目录

```bash
# 创建缓存目录
sudo mkdir -p /var/cache/nginx/unpkg
sudo mkdir -p /var/cache/nginx/packager

# 设置权限
sudo chown -R nginx:nginx /var/cache/nginx
# 或者（取决于你的系统）
sudo chown -R www-data:www-data /var/cache/nginx

# 设置权限
sudo chmod -R 755 /var/cache/nginx
```

#### 步骤 2: 修改配置

**方法 A: 使用完整配置（推荐）**

```bash
# 备份现有配置
sudo cp /etc/nginx/sites-available/default /etc/nginx/sites-available/default.bak

# 复制优化配置
sudo cp nginx-optimized.conf /etc/nginx/sites-available/codesandbox

# 修改配置中的实际地址
sudo nano /etc/nginx/sites-available/codesandbox
# 修改以下内容：
# - server 10.4.5.136:3001;  # 改为你的 unpkg 服务地址
# - server 10.4.5.136:3002;  # 改为你的 packager 服务地址
# - root /usr/share/nginx/html/www;  # 改为你的 www 目录

# 启用配置
sudo ln -sf /etc/nginx/sites-available/codesandbox /etc/nginx/sites-enabled/

# 禁用默认配置（如果需要）
sudo rm /etc/nginx/sites-enabled/default
```

**方法 B: 手动添加优化项**

在现有配置文件中添加：

```nginx
# 在 http 块中添加
upstream unpkg_backend {
    server 你的unpkg服务地址;
    keepalive 32;
}

upstream packager_backend {
    server 你的packager服务地址;
    keepalive 32;
}

proxy_cache_path /var/cache/nginx/unpkg levels=1:2 keys_zone=unpkg_cache:100m max_size=10g inactive=7d;

# 在 server 块中修改
location /unpkg/ {
    rewrite ^/unpkg/(.*)$ /$1 break;
    proxy_pass http://unpkg_backend;
    
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    
    proxy_cache unpkg_cache;
    proxy_cache_valid 200 304 7d;
    add_header X-Cache-Status $upstream_cache_status;
}
```

#### 步骤 3: 测试并重新加载

```bash
# 测试配置
sudo nginx -t

# 如果测试通过，重新加载
sudo nginx -s reload
```

## 性能对比测试

### 测试工具

```bash
# 安装 apache bench（如果没有）
sudo apt-get install apache2-utils  # Ubuntu/Debian
# 或
sudo yum install httpd-tools  # CentOS/RHEL

# 安装 curl
sudo apt-get install curl
```

### 测试命令

```bash
# 1. 测试直接访问 unpkg 服务
time curl -o /dev/null -s http://10.4.5.136:3001/react@18.0.0/package.json

# 2. 测试通过 Nginx 代理（第一次，冷缓存）
time curl -o /dev/null -s http://10.4.5.136/unpkg/react@18.0.0/package.json

# 3. 测试通过 Nginx 代理（第二次，热缓存）
time curl -o /dev/null -s http://10.4.5.136/unpkg/react@18.0.0/package.json

# 4. 压力测试（100 个请求，10 个并发）
ab -n 100 -c 10 http://10.4.5.136/unpkg/react@18.0.0/package.json
```

### 预期结果

- **冷缓存（第一次）**: 可能比直接访问慢 10-50ms
- **热缓存（后续）**: 应该比直接访问快 50-90%
- **并发测试**: 缓存命中率应该 > 90%

## 验证优化效果

### 1. 查看缓存命中率

```bash
# 访问几次后，检查响应头
curl -I http://10.4.5.136/unpkg/react@18.0.0/package.json | grep X-Cache-Status

# 结果解释：
# HIT - 缓存命中（最佳）
# MISS - 缓存未命中（第一次访问正常）
# BYPASS - 绕过缓存
# EXPIRED - 缓存过期
# UPDATING - 正在更新缓存
```

### 2. 查看缓存统计

```bash
# 查看缓存目录大小
du -sh /var/cache/nginx/unpkg
du -sh /var/cache/nginx/packager

# 查看缓存文件数量
find /var/cache/nginx/unpkg -type f | wc -l
```

### 3. 在浏览器中验证

打开开发者工具（F12）→ Network 标签，刷新页面：

- 第一次访问：Response Headers 中 `X-Cache-Status: MISS`
- 后续访问：Response Headers 中 `X-Cache-Status: HIT`
- 第二次访问时，Size 列会显示 `(from disk cache)` 或类似

## 常见问题

### Q1: 配置后仍然很慢

**检查清单：**
```bash
# 1. 确认 keepalive 生效
sudo netstat -antp | grep nginx | grep ESTABLISHED

# 2. 确认缓存目录权限正确
ls -la /var/cache/nginx/

# 3. 查看 Nginx 错误日志
sudo tail -f /var/log/nginx/error.log

# 4. 确认 upstream 地址正确
sudo nginx -T | grep upstream -A 5
```

### Q2: X-Cache-Status 一直是 MISS

**可能原因：**
- 缓存目录权限问题
- 缓存配置未生效
- 请求带有 `Cache-Control: no-cache` 头

**解决：**
```bash
# 检查缓存配置
sudo nginx -T | grep proxy_cache

# 手动测试缓存
curl -I http://10.4.5.136/unpkg/react@18.0.0/package.json
# 再执行一次
curl -I http://10.4.5.136/unpkg/react@18.0.0/package.json
# 第二次应该看到 X-Cache-Status: HIT
```

### Q3: 缓存占用太多空间

**调整缓存大小：**
```nginx
proxy_cache_path /var/cache/nginx/unpkg 
    levels=1:2 
    keys_zone=unpkg_cache:100m 
    max_size=5g    # 改小这个值
    inactive=3d    # 改短这个时间
    use_temp_path=off;
```

### Q4: 某些文件不应该缓存

**排除特定路径：**
```nginx
location /unpkg/ {
    # 其他配置...
    
    # 不缓存特定文件
    if ($request_uri ~* "/(package\.json|\.map)$") {
        set $no_cache 1;
    }
    
    proxy_cache_bypass $no_cache;
    proxy_no_cache $no_cache;
}
```

## 清除缓存

```bash
# 清除所有缓存
sudo rm -rf /var/cache/nginx/unpkg/*
sudo rm -rf /var/cache/nginx/packager/*

# 或者使用 Nginx 的缓存清除模块（如果安装了）
# curl -X PURGE http://10.4.5.136/unpkg/react@18.0.0/package.json
```

## 监控和调优

### 1. 启用状态页面

在配置中添加：
```nginx
location /nginx_status {
    stub_status on;
    access_log off;
    allow 127.0.0.1;
    deny all;
}
```

访问：`curl http://localhost/nginx_status`

### 2. 调优参数（根据实际情况）

```nginx
# 如果内存充足，增加缓存大小
proxy_cache_path ... keys_zone=unpkg_cache:200m max_size=20g ...

# 如果并发高，增加 keepalive 连接数
keepalive 64;

# 如果网络稳定，减少超时时间
proxy_connect_timeout 5s;
proxy_read_timeout 15s;
```

## 进一步优化

### 1. 使用 HTTP/2

```nginx
listen 443 ssl http2;
ssl_certificate /path/to/cert.pem;
ssl_certificate_key /path/to/key.pem;
```

### 2. 启用 gzip 压缩

```nginx
gzip on;
gzip_vary on;
gzip_min_length 1024;
gzip_types text/plain text/css text/javascript application/json application/javascript;
```

### 3. 使用 CDN

如果有预算，可以在 Nginx 前面加一层 CDN（如 Cloudflare、阿里云 CDN）。

## 总结

通过以上优化，性能提升应该达到：

- **首次访问**: 与直接访问接近（-10% ~ +5%）
- **缓存命中**: 比直接访问快 50-90%
- **高并发**: 吞吐量提升 5-10 倍

关键优化点：
1. ✅ upstream + keepalive（连接复用）
2. ✅ proxy_cache（缓存）
3. ✅ HTTP/1.1 + Connection ""（协议优化）
4. ✅ 合理的超时和缓冲区设置
