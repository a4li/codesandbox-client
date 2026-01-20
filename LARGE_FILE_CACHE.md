# Nginx 大文件缓存配置指南

## 问题：为什么大文件不会被缓存？

Nginx 默认的缓冲区配置较小，导致大文件无法被有效缓存。

### 默认限制：

1. **proxy_buffers**: 默认 `8 4k` 或 `8 8k`（仅 32-64KB）
2. **proxy_buffer_size**: 默认 `4k` 或 `8k`
3. **proxy_busy_buffers_size**: 默认 `8k` 或 `16k`
4. **proxy_max_temp_file_size**: 默认 `1024m`（1GB）

### 导致的问题：

```
文件大小 > 缓冲区大小 → 使用临时文件 → 缓存效率低或失败
```

## 解决方案

### 1. 调整缓冲区大小（已在配置中）

```nginx
# 全局设置（http 块）
proxy_buffers 16 128k;           # 16个缓冲区，每个128KB = 2MB
proxy_buffer_size 128k;          # 响应头缓冲区 128KB
proxy_busy_buffers_size 256k;    # 可同时发送的缓冲区大小
proxy_max_temp_file_size 2048m;  # 临时文件最大 2GB
proxy_temp_file_write_size 128k; # 一次写入临时文件的大小
```

### 2. packager 专用优化（已在配置中）

```nginx
location /packager2/ {
    # 大文件缓冲区
    proxy_buffer_size 128k;
    proxy_buffers 16 128k;
    proxy_busy_buffers_size 256k;
    
    # 更长的超时
    proxy_read_timeout 120s;
    
    # 更长的缓存锁定时间
    proxy_cache_lock_timeout 30s;
    
    # 允许大文件上传（如果需要）
    client_max_body_size 100m;
}
```

### 3. 增加缓存空间

```nginx
proxy_cache_path /var/cache/nginx/packager 
    levels=1:2 
    keys_zone=packager_cache:100m  # 缓存索引（100MB可以索引约80万个文件）
    max_size=10g                    # 总缓存大小 10GB
    inactive=7d                     # 7天未访问则删除
    use_temp_path=off;              # 直接写入缓存，不使用临时路径
```

## 缓存大小计算

### 缓冲区计算：

```
可缓冲的内存大小 = proxy_buffers 数量 × 单个缓冲区大小
                 = 16 × 128KB 
                 = 2MB
```

**含义**：小于 2MB 的响应可以完全在内存中处理，不需要临时文件。

### keys_zone 计算：

```
keys_zone:packager_cache:100m
```

- **100m**：用于存储缓存键和元数据的共享内存
- **1MB** ≈ 可以存储 **8000个** 缓存键
- **100MB** ≈ 可以存储 **80万个** 缓存键

### max_size 计算：

```
max_size=10g
```

根据你的 packager 文件大小估算需要多少空间：

| 平均文件大小 | 可缓存文件数 | 建议 max_size |
|-------------|-------------|--------------|
| 100KB | 10万个 | 10GB |
| 1MB | 1万个 | 10GB |
| 10MB | 1000个 | 10GB |
| 50MB | 200个 | 10GB+ |

## 验证缓存是否工作

### 1. 测试小文件（< 2MB）

```bash
# 第一次请求（MISS）
curl -I http://10.4.5.136/packager2/react/18.0.0/package.json | grep X-Cache-Status
# 应该显示: X-Cache-Status: MISS

# 第二次请求（HIT）
curl -I http://10.4.5.136/packager2/react/18.0.0/package.json | grep X-Cache-Status
# 应该显示: X-Cache-Status: HIT
```

### 2. 测试大文件（> 2MB）

```bash
# 测试一个大的 bundle 文件
curl -I http://10.4.5.136/packager2/some-large-package/bundle.js | grep X-Cache-Status

# 第二次请求应该也是 HIT
curl -I http://10.4.5.136/packager2/some-large-package/bundle.js | grep X-Cache-Status
```

### 3. 查看缓存文件

```bash
# 查看缓存目录
ls -lh /var/cache/nginx/packager/

# 查看缓存统计
du -sh /var/cache/nginx/packager/
find /var/cache/nginx/packager/ -type f | wc -l

# 查看最近缓存的文件
find /var/cache/nginx/packager/ -type f -mmin -5 -ls
```

### 4. 查看详细缓存信息

在浏览器中：
```javascript
// 在开发者工具 Console 中运行
fetch('http://10.4.5.136/packager2/react/18.0.0/bundle.js')
  .then(r => {
    console.log('Cache Status:', r.headers.get('X-Cache-Status'));
    console.log('Content-Length:', r.headers.get('Content-Length'));
    return r.text();
  })
  .then(data => console.log('Size:', (data.length / 1024 / 1024).toFixed(2), 'MB'));
```

## 监控缓存性能

### 1. 添加详细日志

```nginx
# 在 http 块中定义日志格式
log_format cache_log '$remote_addr - $remote_user [$time_local] '
                     '"$request" $status $body_bytes_sent '
                     '"$http_referer" "$http_user_agent" '
                     'cache:$upstream_cache_status '
                     'time:$request_time '
                     'size:$body_bytes_sent';

# 在 location 中使用
location /packager2/ {
    access_log /var/log/nginx/packager_cache.log cache_log;
    # 其他配置...
}
```

### 2. 分析缓存命中率

```bash
# 统计缓存命中率
grep "cache:HIT" /var/log/nginx/packager_cache.log | wc -l
grep "cache:MISS" /var/log/nginx/packager_cache.log | wc -l

# 计算命中率
# 命中率 = HIT / (HIT + MISS) × 100%

# 查看大文件（> 1MB）的缓存情况
awk '$NF > 1000000 {print}' /var/log/nginx/packager_cache.log | grep cache
```

### 3. 实时监控

```bash
# 实时查看缓存状态
tail -f /var/log/nginx/packager_cache.log | grep cache

# 或者使用 awk 格式化输出
tail -f /var/log/nginx/packager_cache.log | awk '{print $7, $11, $13}'
```

## 性能对比

### 优化前：

```
小文件（< 100KB）: 
  - 第1次: 50ms (MISS)
  - 第2次: 45ms (MISS - 未缓存)
  
大文件（5MB）:
  - 第1次: 500ms (MISS)
  - 第2次: 480ms (MISS - 未缓存)
```

### 优化后：

```
小文件（< 100KB）:
  - 第1次: 50ms (MISS)
  - 第2次: 2ms (HIT - 从内存)
  
大文件（5MB）:
  - 第1次: 500ms (MISS)
  - 第2次: 10ms (HIT - 从磁盘缓存)
```

### 预期改善：

| 场景 | 优化前 | 优化后 | 改善 |
|------|--------|--------|------|
| 小文件缓存命中 | 45ms | 2ms | 95% ⬇️ |
| 大文件缓存命中 | 480ms | 10ms | 98% ⬇️ |
| 高并发请求 | 慢 | 快 | 10-50x ⬆️ |

## 高级优化

### 1. 根据文件大小使用不同策略

```nginx
# 小文件（< 1MB）- 长时间缓存
location ~ ^/packager2/.*\.(json|js|css)$ {
    set $cache_time 30d;
    if ($request_uri ~* "\.json$") {
        set $cache_time 7d;
    }
    
    proxy_cache_valid 200 $cache_time;
    # 其他配置...
}

# 大文件（bundles）- 永久缓存
location ~ ^/packager2/.*bundle\.js$ {
    proxy_cache_valid 200 304 365d;  # 缓存1年
    # 其他配置...
}
```

### 2. 分层缓存

```nginx
# L1 缓存（内存 - 热数据）
proxy_cache_path /dev/shm/nginx/packager_hot 
    levels=1:2 
    keys_zone=packager_hot:50m 
    max_size=500m 
    inactive=1h;

# L2 缓存（SSD/磁盘 - 冷数据）
proxy_cache_path /var/cache/nginx/packager_cold 
    levels=1:2 
    keys_zone=packager_cold:100m 
    max_size=50g 
    inactive=30d;

location /packager2/ {
    # 先尝试热缓存
    proxy_cache packager_hot;
    proxy_cache_valid 200 1h;
    
    # 热缓存未命中则使用冷缓存
    proxy_cache_bypass $upstream_cache_status;
    # 其他配置...
}
```

### 3. 预加载缓存（预热）

```bash
# 创建预热脚本
cat > /usr/local/bin/warm-cache.sh << 'EOF'
#!/bin/bash
# 预热常用包的缓存

PACKAGES=(
    "react/18.0.0/bundle.js"
    "react-dom/18.0.0/bundle.js"
    "lodash/4.17.21/bundle.js"
    # 添加更多常用包
)

for pkg in "${PACKAGES[@]}"; do
    echo "Warming cache for: $pkg"
    curl -s -o /dev/null "http://localhost/packager2/$pkg"
done

echo "Cache warming completed"
EOF

chmod +x /usr/local/bin/warm-cache.sh

# 定时执行（每天凌晨）
echo "0 2 * * * /usr/local/bin/warm-cache.sh" | crontab -
```

## 故障排查

### 问题1：大文件仍然不缓存

**检查：**
```bash
# 1. 检查缓存目录权限
ls -la /var/cache/nginx/packager/
# 应该是 nginx:nginx 或 www-data:www-data

# 2. 检查磁盘空间
df -h /var/cache/nginx/

# 3. 查看错误日志
sudo tail -f /var/log/nginx/error.log | grep cache

# 4. 检查配置是否生效
sudo nginx -T | grep proxy_buffer
```

**常见错误：**
```
[crit] 12345#12345: *1 open() "/var/cache/nginx/packager/..." failed (13: Permission denied)
```

**解决：**
```bash
sudo chown -R nginx:nginx /var/cache/nginx/packager/
sudo chmod -R 755 /var/cache/nginx/packager/
```

### 问题2：缓存占用过多空间

**解决：**
```nginx
# 减小 max_size
proxy_cache_path /var/cache/nginx/packager 
    max_size=5g  # 改小
    inactive=3d  # 缩短过期时间
    # 其他配置...
```

**或手动清理：**
```bash
# 清理旧文件（7天未访问）
find /var/cache/nginx/packager/ -type f -atime +7 -delete

# 清理大文件（> 50MB）
find /var/cache/nginx/packager/ -type f -size +50M -delete
```

### 问题3：缓存响应慢

**原因**：磁盘 I/O 瓶颈

**解决：**
```bash
# 1. 使用 SSD（如果还没有）

# 2. 或者使用内存缓存
# 将缓存移到 /dev/shm（内存盘）
sudo mkdir -p /dev/shm/nginx/packager
sudo chown nginx:nginx /dev/shm/nginx/packager

# 修改配置
proxy_cache_path /dev/shm/nginx/packager 
    levels=1:2 
    keys_zone=packager_cache:100m 
    max_size=2g  # 内存有限，不能太大
    inactive=1d;
```

## 总结

### ✅ 已优化项：

1. **缓冲区大小** - 从 32KB 增加到 2MB
2. **缓存空间** - 从 5GB 增加到 10GB
3. **缓存时间** - 从 3天 增加到 7天
4. **超时设置** - 从 60秒 增加到 120秒
5. **临时文件** - 支持最大 2GB

### 📊 预期效果：

- ✅ 小文件（< 2MB）：完全在内存中处理
- ✅ 大文件（2-100MB）：使用临时文件，仍可缓存
- ✅ 超大文件（> 100MB）：按需调整 `client_max_body_size`
- ✅ 缓存命中率：预期 > 80%
- ✅ 响应时间：缓存命中时 < 20ms

### 🔧 下一步：

```bash
# 1. 创建缓存目录
sudo mkdir -p /var/cache/nginx/packager
sudo chown -R nginx:nginx /var/cache/nginx/packager

# 2. 测试配置
sudo nginx -t

# 3. 重新加载
sudo nginx -s reload

# 4. 监控缓存
sudo tail -f /var/log/nginx/access.log | grep packager2
```
