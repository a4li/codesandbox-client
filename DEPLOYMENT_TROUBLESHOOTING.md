# CodeSandbox 部署问题解决方案

## 问题描述

部署的 CodeSandbox 服务在使用时出现以下错误：

```
TypeError: Failed to fetch
GET https://10.4.5.136/unpkg/antd@4.24.12/lib/style/color/colors.less net::ERR_CONNECTION_REFUSED
TypeError: Cannot read properties of undefined (reading 'lib')
```

## 根本原因

1. **unpkg CDN 访问失败**：代码中配置的 `https://10.4.5.136/unpkg/...` 无法直接访问 unpkg.com 的资源
2. **缺少反向代理配置**：服务器没有配置反向代理将 `/unpkg/*` 请求转发到真实的 unpkg.com
3. **依赖加载失败**：由于无法获取 npm 包资源，导致沙箱环境中的代码执行失败

## 解决方案

### 方案一：使用 Nginx 反向代理（推荐 - 你当前使用的方案）

**完整配置示例已保存在 `nginx.conf.example` 文件中。**

在你的 Nginx 配置文件中（通常是 `/etc/nginx/sites-available/codesandbox` 或 `/etc/nginx/conf.d/codesandbox.conf`）添加以下配置：

```nginx
server {
    listen 80;
    server_name 10.4.5.136;  # 改为你的实际 IP 或域名
    
    # www 目录路径 - 改为你实际部署的路径
    root /usr/share/nginx/html/codesandbox;  # 或 /var/www/codesandbox/www
    index index.html;
    
    # unpkg CDN 代理 - 核心配置
    location /unpkg/ {
        rewrite ^/unpkg/(.*)$ /$1 break;
        proxy_pass https://unpkg.com;
        proxy_ssl_server_name on;
        proxy_set_header Host unpkg.com;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        add_header Access-Control-Allow-Origin *;
    }
    
    # packager 代理
    location /packager2/ {
        rewrite ^/packager2/(.*)$ /$1 break;
        proxy_pass https://prod-packager-packages.codesandbox.io;
        proxy_ssl_server_name on;
        proxy_set_header Host prod-packager-packages.codesandbox.io;
        add_header Access-Control-Allow-Origin *;
    }
    
    # 静态 CDN 资源代理
    location /static/cdn/ {
        rewrite ^/static/cdn/(.*)$ /$1 break;
        proxy_pass https://fonts.googleapis.com;
        proxy_ssl_server_name on;
        proxy_set_header Host fonts.googleapis.com;
    }
    
    # SPA 路由支持
    location / {
        try_files $uri $uri/ /index.html?$query_string;
    }
}
```

**应用配置步骤：**

1. **编辑 Nginx 配置文件**
```bash
sudo nano /etc/nginx/sites-available/codesandbox
# 或
sudo nano /etc/nginx/conf.d/codesandbox.conf
```

2. **测试配置是否正确**
```bash
sudo nginx -t
```

3. **如果测试通过，重新加载 Nginx**
```bash
sudo systemctl reload nginx
# 或
sudo nginx -s reload
```

4. **查看 Nginx 日志（如果有问题）**
```bash
sudo tail -f /var/log/nginx/error.log
sudo tail -f /var/log/nginx/access.log
```

### 方案二：使用 Caddy 反向代理

如果你想改用 Caddy，配置已在 `Caddyfile` 中，运行：
```bash
caddy run --config Caddyfile
```

### 方案三：搭建本地 unpkg 镜像（高级方案）

如果需要完全离线环境或更快的访问速度，可以搭建本地 unpkg 镜像：

1. **使用 Verdaccio 作为私有 npm 仓库**

```bash
# 安装 Verdaccio
npm install -g verdaccio

# 启动服务（默认端口 4873）
verdaccio
```

2. **修改代码中的 unpkg 地址**

在以下文件中将 `https://10.4.5.136/unpkg` 改为你的 Verdaccio 地址：
- `packages/sandpack-core/src/npm/dynamic/fetch-protocols/unpkg.ts`
- `packages/common/src/utils/dependencies.ts`
- `standalone-packages/codesandbox-browserfs/src/backend/UNPKGRequest.ts`

3. **配置 Caddy 代理到 Verdaccio**

```caddyfile
handle_path /unpkg/* {
  reverse_proxy http://localhost:4873
}
```

## 验证配置

### 1. 检查反向代理是否生效

```bash
# 测试 unpkg 代理
curl -I https://10.4.5.136/unpkg/react@18.0.0/package.json

# 应该返回 200 状态码
```

### 2. 检查浏览器控制台

重新加载页面，在浏览器开发者工具的 Network 标签中检查：
- `/unpkg/` 开头的请求应该返回 200 状态码
- 不应该再有 `ERR_CONNECTION_REFUSED` 错误

### 3. 测试沙箱功能

在 CodeSandbox 中创建一个新的沙箱，尝试：
- 安装 npm 包（如 `antd`, `lodash` 等）
- 导入并使用这些包
- 检查是否能正常加载样式文件

## 常见问题排查

### Q1: 仍然出现 Failed to fetch 错误

**可能原因：**
- Caddy 服务未重启
- 浏览器缓存了旧的错误响应
- 防火墙阻止了出站 HTTPS 请求

**解决方法：**
```bash
# 重新加载 Nginx 配置
sudo nginx -s reload

# 清除浏览器缓存或使用无痕模式测试

# 检查 Nginx 是否在运行
sudo systemctl status nginx

# 检查防火墙规则
sudo iptables -L -n | grep 443

# 测试代理是否工作
curl -I http://10.4.5.136/unpkg/react@18.0.0/package.json
```

### Q2: SSL 证书错误

**可能原因：**
- 使用 HTTPS 访问内网 IP
- 自签名证书不被信任

**解决方法：**
1. 使用域名而不是 IP 地址访问
2. 如果使用 HTTP，确保浏览器不强制 HTTPS
3. 如果使用 HTTPS，配置 Nginx SSL：
```nginx
server {
    listen 443 ssl http2;
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    # 其他配置...
}
```

### Q3: CORS 跨域错误

**解决方法：**

在 Nginx 配置中添加 CORS 头：

```nginx
# 在 server 块中添加
add_header Access-Control-Allow-Origin *;
add_header Access-Control-Allow-Methods "GET, POST, OPTIONS";
add_header Access-Control-Allow-Headers "Content-Type, Authorization";

# 或者只在代理 location 中添加
location /unpkg/ {
    # ... 其他配置
    add_header Access-Control-Allow-Origin *;
}
```

## 性能优化建议

1. **启用 Nginx 缓存**

```nginx
# 在 http 块中定义缓存路径
http {
    proxy_cache_path /var/cache/nginx/codesandbox levels=1:2 keys_zone=codesandbox_cache:10m max_size=1g inactive=60m;
}

# 在 server 块中使用缓存
server {
    location /unpkg/ {
        proxy_cache codesandbox_cache;
        proxy_cache_valid 200 1d;
        proxy_cache_valid 404 1m;
        proxy_cache_key "$scheme$request_method$host$request_uri";
        add_header X-Cache-Status $upstream_cache_status;
        
        # 其他配置...
    }
}
```

2. **启用 gzip 压缩**

```nginx
server {
    gzip on;
    gzip_vary on;
    gzip_min_length 1024;
    gzip_types text/plain text/css text/xml text/javascript 
               application/x-javascript application/xml+rss 
               application/javascript application/json;
}
```

3. **使用国内 CDN 镜像**（推荐）

如果在中国大陆部署，使用国内镜像会显著提升速度：

```nginx
location /unpkg/ {
    rewrite ^/unpkg/(.*)$ /$1 break;
    # 使用知乎镜像
    proxy_pass https://unpkg.zhimg.com;
    proxy_ssl_server_name on;
    proxy_set_header Host unpkg.zhimg.com;
}

# 或者使用 jsDelivr（也有国内节点）
location /unpkg/ {
    rewrite ^/unpkg/(.*)$ /npm/$1 break;
    proxy_pass https://cdn.jsdelivr.net;
    proxy_ssl_server_name on;
    proxy_set_header Host cdn.jsdelivr.net;
}
```

可用的镜像：
- https://unpkg.com (全球)
- https://unpkg.zhimg.com (知乎镜像，国内快)
- https://cdn.jsdelivr.net/npm (jsDelivr，全球+国内 CDN)

## 长期解决方案

为了避免依赖外部服务，建议：

1. **搭建私有 npm 仓库**（如 Verdaccio、Nexus）
2. **定期同步常用包**到本地
3. **配置代码中的 CDN 地址为环境变量**，便于不同环境切换

可以在 `.env` 文件中配置：

```env
UNPKG_URL=https://your-domain.com/unpkg
PACKAGER_URL=https://your-domain.com/packager2
```

然后修改代码使用环境变量而不是硬编码 URL。

## 总结

通过在 Nginx 中添加反向代理配置，解决了 CodeSandbox 无法访问 unpkg CDN 的问题。

**核心改动：**
- 在 Nginx 配置中添加 `/unpkg/*` 反向代理到 `unpkg.com`
- 添加 `/packager2/*` 反向代理到 CodeSandbox packager 服务
- 添加 `/static/cdn/*` 反向代理到 Google Fonts 等静态资源

**完整配置示例：** 请参考项目根目录的 `nginx.conf.example` 文件

**应用配置后记得：**
```bash
# 测试配置
sudo nginx -t

# 重新加载 Nginx
sudo systemctl reload nginx
```
