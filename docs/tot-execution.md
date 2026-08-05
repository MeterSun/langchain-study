# Tree of Thoughts 执行流程示意

基于 [example/14-tot.ts](file:///Users/zhang/github/langchain-study/example/14-tot.ts) 的实际运行数据，演示 `ToTAgent.solve()` 的完整执行过程。

## 配置

```
numThoughts = 3    每步生成 3 个候选
beamWidth   = 2    每层保留 top-2 继续扩展
maxDepth    = 4    最大 4 层
solutionThreshold = 0.95   达到此分即终止
```

## 执行流程（Beam Search 逐层展开）

```
问题: 写 200 字悬疑微小说，有反转结局
初始: "午夜，她收到一封没有署名的信。"
```

```
depth=0  beam=[root]
         │
         ▼  generateThoughts(root) → 3 个候选
         │
         │  评估:
         │    n0 "母亲字迹"     score=0.55 ✅ top-2
         │    n1 "铜钥匙"       score=0.40
         │    n2 "窗外的脸"     score=0.50 ✅ top-2
         │
         ▼  beam = [n0, n2]   (bestLeaf=n0, 0.55)

depth=1  对 beam 中每个节点各生成 3 候选
         │
         ├─ n0 → n3, n4, n5
         │       评估: n3=0.60  n4=0.50  n5=0.55
         │
         └─ n2 → n6, n7, n8
                 评估: n6=0.50  n7=0.80  n8=0.82 ★
         │
         │  6 个候选排序取 top-2:
         │    n8 "她才是窗外的人"  0.82 ✅  (LLM 标 isSolution=true)
         │    n7 "信纸夹层老照片"  0.80 ✅
         │
         ▼  beam = [n8, n7]   (bestLeaf=n8, 0.82)

depth=2  循环 beam:
         │
         ├─ n8.isSolution=true → continue (跳过扩展)
         │
         └─ n7 → n9, n10, n11
                 评估: n9=0.72  n10=0.80  n11=0.75
         │
         │  3 个候选排序取 top-2:
         │    n10 "镜子举手"     0.80 ✅
         │    n11 "18楼敲门"     0.75 ✅
         │
         ▼  beam = [n10, n11]  (bestLeaf 仍 n8, 0.82 > 0.80)

depth=3  对 beam 中每个节点各生成 3 候选
         │
         ├─ n10 → n12, n13, n14
         │        评估: n12=0.78  n13=0.75  n14=0.60
         │
         └─ n11 → n15, n16, n17
                  评估: n15=0.85 ★  n16=0.85  n17=0.65
         │
         │  6 个候选排序取 top-2:
         │    n15 "镜中微笑反转"  0.85 ✅
         │    n16 "翻看照片背面"  0.85 ✅
         │
         ▼  beam = [n15, n16]  (bestLeaf 更新为 n15, 0.85 > 0.82)

depth=4  达到 maxDepth，循环结束
```

## 最终：回溯最优路径

```
bestLeaf = n15 (score=0.85)

沿 parent 指针回溯到 root:

  root ──→ n2 ──→ n7 ──→ n11 ──→ n15
  (初始)  (窗外的脸) (老照片) (18楼敲门) (镜中微笑反转)
  0.00    0.50      0.80     0.75       0.85
```

对应代码 [src/core/tot.ts#L271-L276](file:///Users/zhang/github/langchain-study/src/core/tot.ts#L271-L276)：

```ts
const bestPath: ThoughtNode[] = [];
let cur: ThoughtNode | undefined = bestLeaf;
while (cur) {
  bestPath.unshift(cur);   // 从叶往根 unshift → 根到叶顺序
  cur = cur.parent;
}
```

## 最终故事

```
午夜，她收到一封没有署名的信。
她放下信，抬头发现窗外的玻璃上紧紧地贴着一张惨白的脸，正在对她微笑。
信纸夹层掉出一张泛黄照片，照片里的她站在同样的窗前，窗外也贴着一张微笑的脸。
窗外传来急促的敲门声，可她的公寓在十八楼，而那张脸已经在玻璃上消失了。
她猛地转身，镜中的自己正挂着与窗外那张脸相同的微笑，而她的手正缓缓抬起。
```

## 关键机制示意

### 1. Beam Search 的"剪枝"

```
BFS（全展开）:  3 → 9 → 27 → 81  = 120 节点
Beam(B=2):     3 → 6 → 6 → 6   = 21 节点   ← 本次实际 19 个
```

每层只保留 top-2，低分分支（如 n1 铜钥匙 0.40、n5 黑猫 0.55）被剪掉，不再扩展。

### 2. isSolution 的两种作用

```ts
// 作用 1：跳过扩展（深度 2 的 n8）
for (const node of beam) {
  if (node.isSolution) continue;   // n8 不再生成子节点
}

// 作用 2：触发终止（需要 score >= threshold）
const solution = candidates.find(
  (c) => c.isSolution && c.score >= this.solutionThreshold,  // 0.95
);
if (solution) { bestLeaf = solution; break; }
```

n8 虽然 `isSolution=true`，但 score=0.82 < 0.95，所以只跳过扩展，不触发终止。本次没达到 0.95，最终靠 maxDepth 收尾。

### 3. bestLeaf 的更新逻辑

```ts
// 每层都找本层最高分，与历史 bestLeaf 比
const depthBest = candidates.reduce((best, c) =>
  c.score > best.score ? c : best,
);
if (depthBest.score > bestLeaf.score) {
  bestLeaf = depthBest;
}
```

| depth | 本层最高 | bestLeaf 变化 |
|-------|---------|--------------|
| 1 | n0=0.55 | root(0) → n0(0.55) |
| 2 | n8=0.82 | n0(0.55) → n8(0.82) |
| 3 | n10=0.80 | 不变（0.80 < 0.82）|
| 4 | n15=0.85 | n8(0.82) → n15(0.85) |

注意：bestLeaf 不一定是最后一条路径的叶节点 —— 它是**全局**分数最高的叶节点，可能在中间某层（如 n8 在 depth=2）。最终 n15(0.85) 超过 n8(0.82) 才更新。

## 总结

ToT 的核心循环：**生成 → 评估 → 剪枝 → 重复 → 回溯最优路径**

```
while (depth < maxDepth):
  1. generateThoughts(beam)      → 候选列表
  2. evaluateNodes(candidates)   → 填充 score
  3. find solution               → 命中则 break
  4. update bestLeaf             → 全局最优
  5. beam = top-B(candidates)    → 剪枝

return bestPath(root → bestLeaf)
```
