# 2026-11-17 02:20–02:50 · three-d · llinok111/quant-budget-lab（已发布）
- 仓库：https://github.com/llinok111/quant-budget-lab（public，pushed_at 2026-11-16T18:26Z）
- 承诺：同一 24,576 B 顶点预算下，全局最大顶点误差上界 7.1903e-3
  vs 均匀位宽 3.0527e-2（4.25×）/ 单一世界栅格 5.7170e-2（7.95×）；等价误差下省 14.35% 字节。
- 证据：bench/verify.mjs 14 passed / 0 failed（含 531,441 组穷举，最优解 delta 0.00e+0；
  6 primitive 子实例位宽数组完全相同）；表面误差 oracle 独立于量化常量（点→原始三角形），
  budgeted 4.2975e-3 ≤ 上界，vs uniform 4.33×、vs 世界栅格 10.03×。
- 尺度：1e-6/1e-3/1/1e3/1e6，位宽决策逐位相同，|bound/s−1| 最大 4.00e-15。
- 性能：cold 22.766 ms，中位 2.540 ms，p95 3.353 ms，样本 10（3 warmup + 9 measured），relSD 10.76%
  （第 8 次 3.353 ms 双峰，README 已解释）。
- 页面：G6 200 + importmap=1；滑杆换预算（8–57 KiB）、三种策略切换、点选 primitive 显示该件 bits/误差；
  页面用 Web Crypto 复算 plan sha256，可与 node 的 9eb4050… 对照。
- 发现并修的真 bug：顶点误差界最初用单轴 max(step)，漏了 √3 倍，verify 抓到 ratio 1.235>1，
  改为欧氏 0.5·‖step‖₂ 后 24/24 全部 ≤ 上界（最紧 0.8639）。
- 上游 PR：0 个（原创，无第三方代码可回投；只读调研确认 gltfpack/Draco/gltf-transform 均无跨 primitive 预算分配）。
- 已知未做（下一轮）：
  1. 导出真实 KHR_mesh_quantization glTF（每 primitive 一个 node 的 TRS + normalized SHORT），当前只有分配方案 + 位打包 payload；
  2. 扩到 normal/UV/索引（当前只 POSITION，索引三策略同为 32-bit，不变量）；
  3. 表面误差 160 采样/primitive 是下界性质估计，可加逐三角形自适应细分把 max 收紧。
- 与 quant-cert-lab（11-13）/ quantbound-lab（11-15）的区别：那两个是 ε→每 primitive 位宽、无跨件预算；
  本轮是总字节→全局 minimax（求解方向相反），且用穷举证明最优、用独立 oracle 测表面误差。
- 集群中央 state 追加失败：/home/ubuntu/GitHub/pipelines/state 需 danger-full-access 审批且无审批通道；
  本文件在 work 目录，按章程由执行器归档。runs.jsonl / innovation.md / used-upstreams.txt 的行已全文写在本目录 state/append-*.txt。
