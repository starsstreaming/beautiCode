# 皮肤中心目录契约

所有宿主的皮肤中心都只读取固定生产站点 `https://hnnulwh.cn`。运行时不接受环境变量、配置文件或远程返回值改写这个来源；皮肤资源 URL 也由安全的皮肤 ID 在该来源上派生。

目录条目至少需要 `id`、`name`、`type` 和 `status`。只有 `status: "approved"` 的 `image` / `video` 条目会进入皮肤中心；缺少安全 ID、名称、类型或可信来源时会 fail-closed。

## 来源修订标识

`sourceVersion` 是 provenance 中的来源版本/出版修订标识，不保证是语义版本号。解析优先级为：

1. `version`：保留为 `version:<value>`；
2. 严格有效的 `updatedAt`：规范化为 `updatedAt:<ISO UTC>`；
3. `etag` 或 `ETag`：保留为 `etag:<value>`；
4. 严格有效的 `approvedAt`：作为出版修订，规范化为 `approved-at:<ISO UTC>`。

`approvedAt` 必须是带时间、秒和时区的 ISO 时间字符串，日期和时间字段也必须有效；它不是伪造的语义版本。上述字段全部缺失或无效时，条目会被拒绝。当前真实接口使用的 `createdAt` 仅作展示/审计信息，不作为修订标识。
