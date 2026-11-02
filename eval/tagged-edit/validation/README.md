# 本地验证记录

本轮没有模型供应商请求。targeted.log.txt 为 9 项定向验证（含 JDK 编译及参考修改 / 反例行为）。intermediate-workspace-guard.log.txt.gz 保留首轮完整回归：166/167 通过，一项检测到运行期间新增准备文件而拒绝 Repair 续跑。未放宽保护，冻结文件后重新运行；最终结果见 final-full.log.txt 和 summary.json。

参考修改 / 反例验证结果不能计入三策略模型成绩。历史实验及之前规则覆盖审计未覆盖或修改。
