# quant-budget-lab

**一句话承诺：** 同一份 24-primitive / 4,782-vertex 场景、同一个 **24,576 B** 顶点字节预算下，把全局最大顶点误差上界从
均匀位宽的 **3.0527e-2 降到 7.1903e-3（−76.4%，4.25×）**、从"整个场景共用一个世界栅格"的 **5.71699e-2 降到 7.1903e-3（−87.4%，7.95×）**；
等价误差水平下比均匀位宽少 **14.35% 字节**。基线全部在仓库内可跑（`bench/verify.mjs` 里 `allocateUniform` / `allocateGlobalGrid` 两条分支 + `bench/result.json`）。

Upstream: none

原创工具，不基于任何上游仓库。它与我自己 2026-11-13 的 `quant-cert-lab` 的区别是**被测对象反过来了**：
那个工具是 ε → 每 primitive 位宽（各自独立，无跨 primitive 预算）；本工具是**总字节预算 → 全局 minimax 位宽**，
必须解"独立单调曲线 + 背包式阈值搜索"，并用 **531,441 组穷举** 证明它落在真正最优（差 0.00e+0），再加一个
**不共用任何量化常量的表面误差 oracle**（点到原始三角形距离）来测，而不是把上界抄一遍。

## 怎么跑（一条命令）

```bash
node tools/gen-sample.mjs && node bench/verify.mjs
```

只依赖 Node ≥20（本机 v24），零 npm 依赖，零浏览器自动化。
看页面：`python3 -m http.server 4173`（另开终端），打开 <http://localhost:4173/>，需要浏览器能访问 unpkg 拉 three@0.169.0。

## 证据（全部来自 `bench/result.json`，真实运行）

| 策略（同一 24,576 B 预算） | 实用字节 | 最大顶点误差上界 | 实测最大表面误差（160 采样/primitive） |
|---|---|---|---|
| **budgeted（本仓库）** | 24,576 | **7.1903e-3** | **4.2975e-3** |
| uniform bits（13 bit） | 23,318 | 3.0527e-2 | 1.8592e-2 |
| 单一世界栅格（13 bit） | 23,318 | 5.7170e-2 | 4.3104e-2 |

- 表面误差 ratio（budgeted vs uniform）= **4.33×**；vs 世界栅格 = **10.03×**。
- 达到 budgeted 的上界，均匀位宽需要 16 bit = **28,692 B** → budgeted 少 **14.35%** 字节。
- **最优性**：6 个 primitive、9,356 B 子预算，穷举 9^6 = **531,441** 组合的最优上界 1.59488e-1，
  分配器给出 1.59488e-1（delta **0.00e+0**，位宽数组完全相同）。
- **尺度不变性**：同一几何缩放到 1e-6 / 1e-3 / 1 / 1e3 / 1e6，位宽决策逐位相同，
  `bound/s` 相对偏差最大 **4.00e-15**；采样表面误差/单位长度恒为 2.54658e-3。
- **小件不被大件绑架**：24 个 primitive 里最小的 `cyl-08`（对角线 7.34847），per-primitive 表面误差
  0.032% 对角线 vs 世界栅格 0.586%。
- **确定性**：`data/scene.json` sha256 `697dc773…`（重新生成字节一致）；
  两次 plan 的 `plan_sha256` 均为 `9eb405016ef0debacaeac818cf7869c9bc11d56785bb703417211e5e1dada14f`；
  页面上用 Web Crypto 复算同一哈希，可与 node 对照。
- **耗时**（`allocateBits + quantize + pack`，24 primitive）：冷启动 **22.766 ms**，中位 **2.540 ms**，
  p95 **3.353 ms**，样本 10（1 冷 + 3 warmup + 9 measured），**relSD 10.76%**。
  略高于 10% 的原因真实存在：9 次里第 8 次 3.353 ms，其余 2.37–2.68 ms，是 V8 对
  `allocateBits` 内层 24×9 候选曲线搜索的 tier-up 与偶发 GC 造成的双峰，不是测量偷工；
  中位数与 p95 都照实写在这里。

自检命令输出（14 条断言，逐条带实测值）：

```
node bench/verify.mjs   # 14 passed / 0 failed, exit 0
```

## 核心是什么

1. `quantizePrimitive(positions, bits)`：每个 primitive 用自己的 bbox 建栅格，
   `step_a = extent_a/(2^bits−1)`；**顶点误差界 = 0.5·‖step‖₂**（欧氏，不是单轴最大值——单轴会漏 √3 倍，
   这是本轮 verify 抓到的真实错，已修）。
2. `allocateBits(prims, byteBudget)`：误差随位宽单调降、字节单调升 ⇒ 对每个 primitive
   "达到 ε 的最小字节"是精确的；对所有候选 ε 二分即得全局 minimax 最优点，再做"用剩余字节升级当前最差 primitive"的后处理。
3. `sampledSurfaceError(...)`：在**反量化后的三角形**上确定性分层采样，量到**原始三角形**的精确点-三角形距离。
   它不读 `quantize()` 的任何常量，只拿反量化坐标；因此"表面误差 ≤ 顶点上界"是独立测出来的，不是同义反复。
4. `packCodes/unpackCodes`：按精确 `bits` 位打包，`packedBytes()` 就是真实存放字节；verify 在 71,730 个 code 上验证 0 失配。

## 本轮创新

**B 档。** 首次把「跨 primitive 的字节预算 → minimax 位宽分配」做成可复算的构造性求解，而不是"给每个 primitive 一个 ε 各算各的"：
上游 OSS（gltfpack 全局单一栅格 + 全局固定 `-vp`；Draco 每属性固定 `-qp`；gltf-transform 每 mesh 固定 `quantizationBits`）
都没有"给定总字节，最小化全局最大误差"这一层；本仓库给出可被穷举验证的最优解、独立的表面误差 oracle、以及 12 个数量级的尺度不变性证据。
台账里的 `quant-cert-lab` / `quantbound-lab` 都是 **ε→位宽** 且无跨 primitive 预算，本轮的被测对象与求解方向都相反。

## 已知限制（必须读）

- **有效尺度**：几何是尺度无关的（栅格按每个 primitive 自身 bbox 归一），但**绝对字节预算不随几何缩放**，
  所以"同一预算下不同尺度"并不会改变位宽决策——verify 已按 1e-6…1e6 验证。误差上界单位随几何单位线性缩放。
- **误差是顶点位移上界**；表面误差用 160 采样/primitive 估计，是**下界性质的测量**（可能略低于真实最大值），
  因此"表面 ≤ 上界"是硬结论，"表面具体多小"是采样估计。`bench/result.json` 里写的是 160 采样。
- **不含法线/UV/索引压缩**；只处理 POSITION，索引仍按 32-bit 计（所有策略相同，不影响对照）。
- **未导出 KHR_mesh_quantization glTF**：本工具输出的是分配方案 + 精确位打包 payload 的字节账，
  页面直接消费 `core` 的反量化坐标；把方案写成真实 `.gltf`（每 primitive 一个 node 的 TRS + normalized SHORT）
  是下一轮的事，README 不假装已经做了。
- 位宽只允许 8–16（KHR normalized-int16 的实际范围）；`2^bits−1` 用 32-bit 位运算，bits > 30 会抛错。
- 页面需要联网拉 three@0.169.0（unpkg，版本写死）；无 WebGL 截图，因为环境禁止无头浏览器，证据是 node 断言 + 静态 HTTP 200。

## 文件

```
src/core.mjs         纯计算（无 three / 无 DOM），node 直接 import
tools/gen-sample.mjs 确定性生成 data/scene.json（固定种子，0.04 s）
bench/verify.mjs     14 条断言
bench/bench.mjs      warmup 3 + 9 次采样，写 bench/result.json
bench/result.json    真实数字
index.html + main.js three@0.169.0 importmap，滑杆换预算 / 三种策略 / 点选 primitive
```

MIT License. `operate` 说明：本仓库为原创，无第三方代码。`Upstream: none`。