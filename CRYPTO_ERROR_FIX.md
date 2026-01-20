# 解决 crypto 模块加载错误

## 错误信息

```
TypeError: Cannot read properties of undefined (reading 'lib')
    at eval (VM6517 hmac.js:19:20)
    at eval (VM6517 hmac.js:140:3)
    at eval (VM6517 hmac.js:12:3)
    at $csb$eval (VM6517 hmac.js:14:2)
```

## 问题分析

这个错误发生在沙箱运行时，是因为：

1. **crypto-browserify 依赖链不完整**：用户代码使用了依赖 `crypto` 模块的包（如某些加密库）
2. **子模块加载失败**：`crypto-browserify` 依赖的 `create-hmac`、`pbkdf2` 等子模块无法正确加载
3. **unpkg 访问问题**：这些子模块需要从 unpkg CDN 加载，但由于前面的反向代理问题，无法访问

## 解决方案

### 方案一：确保 Nginx 反向代理配置正确（必须）

**这是最重要的步骤！** 如果 unpkg 代理没有配置好，crypto 相关模块无法加载。

确认你的 Nginx 配置中有以下内容：

```nginx
location /unpkg/ {
    rewrite ^/unpkg/(.*)$ /$1 break;
    proxy_pass https://unpkg.com;
    proxy_ssl_server_name on;
    proxy_set_header Host unpkg.com;
    add_header Access-Control-Allow-Origin *;
}
```

然后重新加载 Nginx：

```bash
sudo nginx -t && sudo nginx -s reload
```

### 方案二：检查特定包的依赖

有些包会使用 Node.js 的 `crypto` 模块，这在浏览器环境中需要特殊处理。

#### 常见会触发此错误的包：

- `crypto` (直接使用)
- `crypto-js`
- 任何使用 `pbkdf2`、`hmac`、加密散列的包
- `bcrypt`、`bcryptjs`
- `uuid` (某些版本)
- Web3 相关包

#### 解决方法：

如果你的沙箱代码中直接或间接使用了这些包，确保：

1. **使用浏览器兼容的版本**

```json
// package.json 中使用浏览器友好的替代品
{
  "dependencies": {
    "crypto-js": "^4.1.1",  // 而不是 "crypto"
    "uuid": "^9.0.0"        // 新版本对浏览器友好
  }
}
```

2. **使用 browser 字段指定替代模块**

CodeSandbox 会自动处理 `package.json` 中的 `browser` 字段。

### 方案三：清除浏览器缓存

**重要！** 即使你修复了 Nginx 配置，浏览器可能缓存了之前的错误响应。

1. **硬刷新页面**
   - Chrome/Edge: `Ctrl + Shift + R` (Windows) 或 `Cmd + Shift + R` (Mac)
   - Firefox: `Ctrl + F5` (Windows) 或 `Cmd + Shift + R` (Mac)

2. **清除站点数据**
   - 打开开发者工具 (F12)
   - 右键点击刷新按钮
   - 选择 "清空缓存并硬性重新加载"

3. **或使用无痕模式测试**
   ```
   Chrome: Ctrl + Shift + N (Windows) 或 Cmd + Shift + N (Mac)
   ```

### 方案四：验证 unpkg 代理是否工作

在浏览器控制台中测试：

```javascript
// 在浏览器控制台运行
fetch('http://10.4.5.136/unpkg/create-hmac@1.1.7/package.json')
  .then(r => r.json())
  .then(d => console.log('✅ unpkg 代理工作正常', d))
  .catch(e => console.error('❌ unpkg 代理失败', e));

fetch('http://10.4.5.136/unpkg/pbkdf2@3.1.4/package.json')
  .then(r => r.json())
  .then(d => console.log('✅ pbkdf2 可访问', d))
  .catch(e => console.error('❌ pbkdf2 不可访问', e));
```

如果返回错误，说明 Nginx 代理配置不正确。

### 方案五：检查网络控制台

1. 打开浏览器开发者工具 (F12)
2. 切换到 Network (网络) 标签
3. 刷新页面
4. 筛选 `/unpkg/` 请求
5. 检查是否有失败的请求（红色）

**常见失败原因：**

| 状态码 | 原因 | 解决方法 |
|--------|------|----------|
| (failed) net::ERR_CONNECTION_REFUSED | Nginx 代理未配置 | 添加 unpkg location 配置 |
| 502 Bad Gateway | DNS 解析问题 | 在 Nginx 添加 `resolver 8.8.8.8;` |
| 504 Gateway Timeout | 网络超时 | 增加 `proxy_read_timeout` |
| 403 Forbidden | CORS 问题 | 添加 CORS 头 |

## 完整的 Nginx 配置示例

```nginx
server {
    listen 80;
    server_name 10.4.5.136;
    
    root /path/to/www;
    index index.html;
    
    # DNS 解析器（如果遇到 502 错误）
    resolver 8.8.8.8 8.8.4.4 valid=300s;
    resolver_timeout 5s;
    
    # unpkg 代理 - 必须！
    location /unpkg/ {
        rewrite ^/unpkg/(.*)$ /$1 break;
        
        proxy_pass https://unpkg.com;
        proxy_ssl_server_name on;
        proxy_ssl_protocols TLSv1.2 TLSv1.3;
        
        proxy_set_header Host unpkg.com;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        
        # 超时设置
        proxy_connect_timeout 30s;
        proxy_read_timeout 60s;
        proxy_send_timeout 60s;
        
        # CORS 头
        add_header Access-Control-Allow-Origin *;
        add_header Access-Control-Allow-Methods "GET, OPTIONS";
        
        # 缓存
        proxy_cache_valid 200 1d;
        proxy_cache_valid 404 1m;
    }
    
    # packager 代理
    location /packager2/ {
        rewrite ^/packager2/(.*)$ /$1 break;
        proxy_pass https://prod-packager-packages.codesandbox.io;
        proxy_ssl_server_name on;
        proxy_set_header Host prod-packager-packages.codesandbox.io;
        proxy_connect_timeout 30s;
        proxy_read_timeout 60s;
        add_header Access-Control-Allow-Origin *;
    }
    
    # SPA 路由
    location / {
        try_files $uri $uri/ /index.html?$query_string;
    }
}
```

## 测试步骤

### 1. 应用 Nginx 配置

```bash
# 测试配置
sudo nginx -t

# 重新加载
sudo nginx -s reload

# 检查状态
sudo systemctl status nginx
```

### 2. 测试 unpkg 访问

```bash
# 测试 create-hmac
curl -I http://10.4.5.136/unpkg/create-hmac@1.1.7/package.json

# 测试 pbkdf2
curl -I http://10.4.5.136/unpkg/pbkdf2@3.1.4/package.json

# 应该返回 200 OK
```

### 3. 清除浏览器缓存

使用无痕模式或清空缓存后重新访问。

### 4. 检查浏览器控制台

不应该再有 `Cannot read properties of undefined` 错误。

## 如果问题仍然存在

### 检查清单：

- [ ] Nginx 配置中有 `/unpkg/` location 块
- [ ] Nginx 已重新加载 (`nginx -s reload`)
- [ ] 服务器可以访问 `https://unpkg.com`（测试：`curl -I https://unpkg.com`）
- [ ] 浏览器缓存已清除
- [ ] 防火墙没有阻止 443 端口出站
- [ ] 在 Network 标签中 `/unpkg/` 请求返回 200

### 查看 Nginx 日志

```bash
# 错误日志
sudo tail -f /var/log/nginx/error.log

# 访问日志
sudo tail -f /var/log/nginx/access.log
```

### 常见错误模式

**错误日志显示：**
```
upstream timed out (110: Connection timed out) while reading response header from upstream
```

**解决：** 增加超时时间
```nginx
proxy_connect_timeout 60s;
proxy_read_timeout 120s;
```

---

**错误日志显示：**
```
no resolver defined to resolve unpkg.com
```

**解决：** 添加 DNS 解析器
```nginx
resolver 8.8.8.8 8.8.4.4;
```

## 替代方案：使用国内镜像

如果服务器在中国大陆，可以使用国内镜像以提高速度和稳定性：

```nginx
location /unpkg/ {
    rewrite ^/unpkg/(.*)$ /$1 break;
    # 使用知乎镜像
    proxy_pass https://unpkg.zhimg.com;
    proxy_ssl_server_name on;
    proxy_set_header Host unpkg.zhimg.com;
    add_header Access-Control-Allow-Origin *;
}
```

其他镜像选项：
- `https://unpkg.com` (官方，国外)
- `https://unpkg.zhimg.com` (知乎，国内)
- `https://cdn.jsdelivr.net/npm` (jsDelivr，全球+国内)

## 总结

`Cannot read properties of undefined (reading 'lib')` 错误主要是由于：

1. **unpkg CDN 无法访问** → 配置 Nginx 反向代理
2. **浏览器缓存了错误** → 清除缓存或使用无痕模式
3. **依赖模块加载失败** → 确保 `/unpkg/` 请求返回 200

按照上述步骤配置好 Nginx 后，这个错误应该就会消失。
