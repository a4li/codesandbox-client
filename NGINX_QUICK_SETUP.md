# CodeSandbox Nginx 快速配置指南

## 问题
部署后出现以下错误：
1. `Failed to fetch` 和 `ERR_CONNECTION_REFUSED` - 无法加载 npm 包资源
2. `Cannot read properties of undefined (reading 'lib')` - crypto 模块加载失败
3. `TypeError: Failed to fetch` - unpkg CDN 访问失败

**这些问题都是同一个根本原因：未配置 unpkg 反向代理**

## 快速解决方案

### 1. 找到你的 Nginx 配置文件

```bash
# 查看 Nginx 配置文件位置
sudo nginx -V 2>&1 | grep -o '\-\-conf-path=\S*'

# 常见位置：
# /etc/nginx/nginx.conf
# /etc/nginx/sites-available/default
# /etc/nginx/conf.d/default.conf
```

### 2. 编辑配置文件

```bash
sudo nano /etc/nginx/sites-available/default
# 或
sudo nano /etc/nginx/conf.d/default.conf
```

### 3. 在 server 块中添加以下配置

找到你的 server 块，在里面添加：

```nginx
# 修改 root 路径为你的 www 目录
root /usr/share/nginx/html/www;  # 改为你的实际路径
index index.html;

# unpkg 代理 - 必须添加！
location /unpkg/ {
    rewrite ^/unpkg/(.*)$ /$1 break;
    proxy_pass https://unpkg.com;
    proxy_ssl_server_name on;
    proxy_set_header Host unpkg.com;
    add_header Access-Control-Allow-Origin *;
}

# packager 代理 - 必须添加！
location /packager2/ {
    rewrite ^/packager2/(.*)$ /$1 break;
    proxy_pass https://prod-packager-packages.codesandbox.io;
    proxy_ssl_server_name on;
    proxy_set_header Host prod-packager-packages.codesandbox.io;
    add_header Access-Control-Allow-Origin *;
}

# 静态资源代理
location /static/cdn/ {
    rewrite ^/static/cdn/(.*)$ /$1 break;
    proxy_pass https://fonts.googleapis.com;
    proxy_ssl_server_name on;
    proxy_set_header Host fonts.googleapis.com;
}

# SPA 路由支持 - 必须添加！
location / {
    try_files $uri $uri/ /index.html?$query_string;
}
```

### 4. 测试配置

```bash
sudo nginx -t
```

如果显示 `test is successful`，继续下一步。

### 5. 重新加载 Nginx

```bash
sudo systemctl reload nginx
# 或
sudo nginx -s reload
```

### 6. 验证配置

```bash
# 测试 unpkg 代理是否工作
curl -I http://10.4.5.136/unpkg/react@18.0.0/package.json

# 应该返回 200 OK
```

### 7. 清除浏览器缓存并重新测试

打开浏览器无痕模式，访问你的 CodeSandbox 地址，问题应该解决了！

## 国内用户优化（可选）

如果服务器在中国大陆，建议使用国内镜像：

```nginx
location /unpkg/ {
    rewrite ^/unpkg/(.*)$ /$1 break;
    proxy_pass https://unpkg.zhimg.com;  # 知乎镜像，速度更快
    proxy_ssl_server_name on;
    proxy_set_header Host unpkg.zhimg.com;
    add_header Access-Control-Allow-Origin *;
}
```

## 完整配置示例

完整的配置示例保存在 `nginx.conf.example` 文件中，包含：
- 缓存配置
- gzip 压缩
- SSL 配置
- 性能优化

## 常见问题

### Q: 仍然报错 Failed to fetch
**A:** 检查：
1. Nginx 是否重新加载成功：`sudo systemctl status nginx`
2. 服务器是否能访问外网：`curl -I https://unpkg.com`
3. 防火墙是否阻止：`sudo iptables -L`

### Q: 502 Bad Gateway
**A:** 可能是 DNS 解析问题，添加：
```nginx
resolver 8.8.8.8 8.8.4.4 valid=300s;
resolver_timeout 5s;
```

### Q: 速度很慢
**A:** 使用国内镜像（见上面的"国内用户优化"）

### Q: 仍然出现 `Cannot read properties of undefined` 错误
**A:** 这通常是浏览器缓存问题：
1. 使用无痕模式测试
2. 或者按 `Ctrl + Shift + R` (Windows) / `Cmd + Shift + R` (Mac) 硬刷新
3. 在开发者工具 Network 标签中检查 `/unpkg/create-hmac` 等请求是否返回 200

## 需要帮助？

- **快速配置**：当前文档 `NGINX_QUICK_SETUP.md`
- **crypto 错误详解**：`CRYPTO_ERROR_FIX.md`
- **完整故障排查**：`DEPLOYMENT_TROUBLESHOOTING.md`
- **完整 Nginx 配置**：`nginx.conf.example`
