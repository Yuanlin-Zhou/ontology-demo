# 代码修改三组实验：仅准备

3 份完整、可编译现有代码，3 种策略，共 9 个准备槽位。provider 模型请求为 **0**，质量结果为 **null**；未开展新的付费模型比较。

manifest.json 保存共享任务 / 源码哈希、提示词哈希、参数计划、知识树与验收器哈希，以及标签召回的实体、路径、计划与省略叶子。graphs/ 和 inputs/ 保存冻结输入。unrun-report.json 是无导入输出时的评估器状态示例，9 项均 missing / not_run，不是 0/9 模型失败。

与历史 flat Rules 实验分开。参考源码位于上级 references/，未填入此目录 results，也未冒充模型产出。尚无 provider usage，不能把没有生成的任务计算成零 token 成本。当前 token 字段只是预备提示词的知识估算。

协议和后续记录要求见 `eval/tagged-edit/PROTOCOL.md`。
