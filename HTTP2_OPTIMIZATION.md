# HTTP/2 环境下的 Nginx 性能优化

## HTTP/2 的优势

使用 HTTP/2 有以下好处：
- ✅ 多路复用 - 一个连接可以并发多个请求
- ✅ 头部压缩 - 减少传输数据量
- ✅ 服务器推送 - 可以主动推送资源
- ✅ 二进制协议 - 比 HTTP/1.1 更高效

## 针对 HTTP/2 的优化配置

### 1. 客户端到 Nginx 使用 HTTP/2

```nginx
server {
    # 启用 HTTP/2（需要 HTTPS）
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    
    # 或者如果使用 HTTP（Nginx 1.9.5+ 支持，但不推荐）
    # listen 80 http2;
    
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    
    # HTTP/2 参数优化
    http2_max_field_size 16k;        # 单个头字段最大大小
    http2_max_header_size 32k;       # 整个请求头最大大小
    http2_max_requests 1000;         # 单个连接最大请求数
    http2_recv_timeout 30s;          # 接收超时
    
    # HTTP/2 推送（可选）
    http2_push_preload on;
    
    # 示例：推送关键资源
    location = /index.html {
        http2_push /static/main.js;
        http2_push /static/main.css;
    }
}
```

### 2. Nginx 到上游服务器的连接优化

即使客户端使用 HTTP/2，Nginx 到上游（你的 unpkg/packager 服务）的连接仍然推荐使用 HTTP/1.1 + keepalive：

```nginx
upstream unpkg_backend {
    server 10.4.5.136:3001;
    
    # 保持长连接
    keepalive 64;           # HTTP/2 客户端多，可以增加这个值
    keepalive_timeout 60s;
    keepalive_requests 1000;
}

location /unpkg/ {
    proxy_pass http://unpkg_backend;
    
    # 使用 HTTP/1.1（不是 HTTP/2）
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    
    # 其他配置...
}
```

**为什么不用 HTTP/2 连接上游？**
- Nginx 到上游的 HTTP/2 支持不如 HTTP/1.1 成熟
- HTTP/1.1 + keepalive 已经足够高效
- 内网环境下，HTTP/1.1 的性能更稳定

## 完整的 HTTP/2 优化配置

### 方案一：使用 HTTPS + HTTP/2（推荐）

```nginx
server {
    # HTTP 自动跳转到 HTTPS
    listen 80;
    listen [::]:80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    
    server_name your-domain.com;
    
    # SSL 证书
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;
    
    # SSL 优化
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384';
    ssl_prefer_server_ciphers off;
    
    # SSL 会话缓存
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    ssl_session_tickets off;
    
    # OCSP Stapling
    ssl_stapling on;
    ssl_stapling_verify on;
    
    # HTTP/2 参数
    http2_max_field_size 16k;
    http2_max_header_size 32k;
    http2_max_requests 1000;
    
    # 其他配置...
    root /path/to/www;
    index index.html;
    
    # unpkg 代理
    location /unpkg/ {
        rewrite ^/unpkg/(.*)$ /$1 break;
        proxy_pass http://unpkg_backend;
        
        # 保持 HTTP/1.1
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        
        # 传递真实协议信息
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Real-IP $remote_addr;
        
        # 缓存配置
        proxy_cache unpkg_cache;
        proxy_cache_valid 200 304 7d;
        add_header X-Cache-Status $upstream_cache_status;
        
        # CORS
        add_header Access-Control-Allow-Origin *;
    }
}
```

### 方案二：内网环境使用 HTTP + HTTP/2（不推荐）

如果必须在内网使用 HTTP（无 SSL），部分 Nginx 版本支持：

```nginx
server {
    # Nginx 1.9.5+ 可以在 HTTP 上使用 HTTP/2
    # 但浏览器通常不支持，这主要用于内网代理场景
    listen 80 http2;
    listen [::]:80 http2;
    
    server_name 10.4.5.136;
    
    # HTTP/2 参数
    http2_max_field_size 16k;
    http2_max_header_size 32k;
    
    # 其他配置同 HTTPS 版本
}
```

**注意：** 大多数浏览器只在 HTTPS 上支持 HTTP/2，所以这种配置实际效果有限。

## 性能对比

### 测试环境
- 客户端：浏览器（支持 HTTP/2）
- Nginx：启用 HTTP/2
- 上游：你的 unpkg/packager 服务（HTTP/1.1）

### 预期性能

| 场景 | HTTP/1.1 | HTTP/2 | 改善 |
|------|----------|--------|------|
| 单个大文件 | 100ms | 95ms | 5% |
| 多个小文件（6个） | 600ms | 150ms | 75% |
| 多个小文件（20个） | 2000ms | 200ms | 90% |
| 高并发请求 | 基准 | 2-3x | 100-200% |

**HTTP/2 最大优势：** 并发请求多个小文件时

### 测试命令

```bash
# 1. 检查服务器是否支持 HTTP/2
curl -I --http2 https://your-domain.com

# 查看响应头中的 HTTP/2 标识
# HTTP/2 200  （而不是 HTTP/1.1 200）

# 2. 使用 nghttp2 测试（需要安装）
nghttp -nv https://your-domain.com/unpkg/react@18.0.0/package.json

# 3. 使用 h2load 压力测试
h2load -n 1000 -c 10 https://your-domain.com/unpkg/react@18.0.0/package.json
```

## HTTP/2 特有的优化

### 1. 服务器推送（Server Push）

可以主动推送客户端需要的资源：

```nginx
location = /index.html {
    # 推送关键资源
    http2_push /static/app.js;
    http2_push /static/app.css;
    http2_push /static/logo.png;
}

# 或者根据 Link 头自动推送
http2_push_preload on;
```

在 HTML 中添加：
```html
<link rel="preload" href="/static/app.js" as="script">
<link rel="preload" href="/static/app.css" as="style">
```

### 2. 连接合并（Connection Coalescing）

如果多个域名指向同一 IP 且使用相同证书，HTTP/2 会合并连接：

```nginx
server {
    listen 443 ssl http2;
    server_name example.com www.example.com cdn.example.com;
    
    # 使用包含所有域名的证书（SAN 证书）
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
}
```

### 3. 优先级控制

HTTP/2 支持流优先级，但 Nginx 会自动处理，通常不需要手动配置。

## 监控 HTTP/2 性能

### 1. 检查 HTTP/2 是否生效

**浏览器检查：**
1. 打开开发者工具（F12）
2. Network 标签
3. 右键表头 → 勾选 "Protocol"
4. 刷新页面，查看 Protocol 列是否显示 "h2"

**命令行检查：**
```bash
# 方法 1：使用 curl
curl -I --http2 -s https://your-domain.com | head -1
# 应该显示：HTTP/2 200

# 方法 2：使用 openssl
echo | openssl s_client -alpn h2 -connect your-domain.com:443 2>/dev/null | grep "ALPN protocol"
# 应该显示：ALPN protocol: h2
```

### 2. 查看连接数

```bash
# 查看 Nginx 的连接数
sudo ss -ant | grep :443 | grep ESTABLISHED | wc -l

# HTTP/2 会显著减少连接数（多路复用）
```

### 3. Nginx 日志格式

添加 HTTP/2 信息到日志：

```nginx
log_format http2 '$remote_addr - $remote_user [$time_local] '
                 '"$request" $status $body_bytes_sent '
                 '"$http_referer" "$http_user_agent" '
                 '$server_protocol $request_time '
                 '$upstream_cache_status';

access_log /var/log/nginx/access.log http2;
```

查看日志：
```bash
# 查看 HTTP/2 请求
sudo tail -f /var/log/nginx/access.log | grep "HTTP/2"

# 统计 HTTP/2 vs HTTP/1.1
sudo grep "HTTP/2" /var/log/nginx/access.log | wc -l
sudo grep "HTTP/1.1" /var/log/nginx/access.log | wc -l
```

## 常见问题

### Q1: 浏览器显示仍然是 HTTP/1.1

**原因：**
1. 没有使用 HTTPS
2. SSL 证书无效
3. Nginx 配置错误
4. 浏览器不支持 HTTP/2

**解决：**
```bash
# 检查 Nginx 配置
sudo nginx -T | grep http2

# 应该看到：
# listen 443 ssl http2;

# 检查 SSL 是否正常
openssl s_client -connect your-domain.com:443 -servername your-domain.com
```

### Q2: HTTP/2 反而比 HTTP/1.1 慢

**可能原因：**
1. 测试单个大文件（HTTP/2 优势不明显）
2. 网络延迟低（内网环境）
3. 上游服务器慢（瓶颈不在协议）

**建议：**
- HTTP/2 主要优化多个小文件并发场景
- 单个大文件下载，差异不大
- 如果上游服务是瓶颈，优化缓存更重要

### Q3: 如何禁用 HTTP/2

如果发现问题，可以临时禁用：

```nginx
# 从这个：
listen 443 ssl http2;

# 改为：
listen 443 ssl;

# 重新加载
sudo nginx -s reload
```

## 最佳实践总结

### ✅ 推荐配置

1. **客户端 → Nginx**: 使用 HTTP/2（需要 HTTPS）
2. **Nginx → 上游**: 使用 HTTP/1.1 + keepalive
3. **启用缓存**: 这比协议优化更重要
4. **使用 CDN**: 配合 HTTP/2 效果更好

### ✅ HTTP/2 配置检查清单

- [ ] `listen 443 ssl http2;`
- [ ] SSL 证书配置正确
- [ ] `http2_max_field_size` 和 `http2_max_header_size` 设置合理
- [ ] 上游使用 `proxy_http_version 1.1;` + `keepalive`
- [ ] 启用 `proxy_cache`
- [ ] 浏览器开发者工具显示 "h2"

### 📊 性能优化优先级

1. **启用缓存** ⭐⭐⭐⭐⭐ （最重要）
2. **连接复用（keepalive）** ⭐⭐⭐⭐
3. **使用 HTTP/2** ⭐⭐⭐
4. **gzip 压缩** ⭐⭐⭐
5. **SSL 优化** ⭐⭐
6. **HTTP/2 推送** ⭐

## 快速验证

```bash
# 1. 配置 HTTP/2
# 编辑 nginx-optimized.conf，取消注释 SSL 相关行

# 2. 测试配置
sudo nginx -t

# 3. 重新加载
sudo nginx -s reload

# 4. 验证 HTTP/2
curl -I --http2 https://your-domain.com

# 5. 浏览器测试
# 打开 F12 → Network → 查看 Protocol 列

# 6. 性能测试
h2load -n 100 -c 10 https://your-domain.com/unpkg/react@18.0.0/package.json
```

如果一切正常，你应该看到：
- ✅ 浏览器 Network 标签显示 "h2"
- ✅ 并发请求时只有 1-2 个 TCP 连接
- ✅ 多个小文件加载速度显著提升
