package relay

// PromptTemplate is a canned probe prompt for the channel test dialog.
//
// These are compiled in rather than stored in a table: they are read-only
// defaults, and a channel probe must keep working on a database that has not
// been seeded. An operator who wants something else types it into the dialog.
type PromptTemplate struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Prompt string `json:"prompt"`
}

// promptTemplates are written so a wrong answer is obvious at a glance: each
// one pins down the format and length, so "the model replied" and "the model
// replied correctly" are not the same observation. They also stay short,
// because every run spends real upstream tokens.
var promptTemplates = []PromptTemplate{
	{
		ID:   "capability",
		Name: "模型能力概览",
		Prompt: "请用中文说明你当前使用的模型名称、两项主要能力，以及用户提交复杂任务时应提供的关键信息。" +
			"使用自然段，不要使用表格、工具或外部引用。总回复不超过 120 个汉字。",
	},
	{
		ID:   "code-review",
		Name: "代码审查",
		Prompt: "请审查以下需求的实现风险：一个 HTTP API 需要支持鉴权、超时、错误处理和请求日志。" +
			"用三条简短建议说明优先级和原因，不要编造未提供的事实。",
	},
	{
		ID:   "troubleshooting",
		Name: "问题排查",
		Prompt: "请给出排查 API 请求失败的步骤。按网络、认证、请求格式、上游响应四个方面排序，" +
			"每项一句，并说明最先应收集的证据。",
	},
	{
		ID:   "summary",
		Name: "结构化摘要",
		Prompt: "请用三条要点总结：如何把一项复杂工程任务拆分为可验证的步骤。" +
			"每条不超过 30 个汉字，不要使用表格。",
	},
	{
		ID:   "chinese-qa",
		Name: "中文问答",
		Prompt: "请用中文解释为什么客户端超时不一定代表上游服务故障。" +
			"给出一个简短例子，并说明日志中应重点查看哪些字段。",
	},
	{
		ID:   "extraction",
		Name: "工单信息抽取",
		Prompt: "阅读下列工单摘要：用户在周一上午提交订单，支付成功后页面仍显示待付款，客服已确认未重复扣款。" +
			"请提取时间、现象、已知事实和下一步核查项，按四行中文输出；不得补充未提供的原因。",
	},
	{
		ID:   "rewrite",
		Name: "用户向改写",
		Prompt: "将下面的产品说明改写为面向普通用户的两段中文：系统会在请求失败后按固定间隔重试三次，并记录每次状态码。" +
			"要求保留事实、避免技术缩写、每段不超过 45 个汉字，末尾给出一个简短标题。",
	},
	{
		ID:   "metrics",
		Name: "指标计算",
		Prompt: "根据以下数据计算并解释结果：某服务一分钟收到 240 个请求，其中 12 个返回 5xx，18 个因客户端取消，其余成功。" +
			"请给出成功率和服务端错误率，保留一位小数，并用两句话说明计算口径。",
	},
	{
		ID:   "release-risk",
		Name: "发布风险评估",
		Prompt: "请判断以下发布方案是否存在风险：先停掉旧版本全部实例，再启动新版本，健康检查失败时由人工回滚。" +
			"列出三个最重要的风险及对应改进，每条包含“风险：”和“改进：”，不要假设额外基础设施。",
	},
	{
		ID:   "json-output",
		Name: "JSON 结构化输出",
		Prompt: "请把零散信息整理成 JSON，字段固定为 title、priority、owner、next_step：" +
			"任务是修复登录超时；优先级高；负责人小林；先收集失败请求的时间范围和状态码。" +
			"只输出合法 JSON，不要使用 Markdown 代码块。",
	},
}

// PromptTemplates returns the built-in probe prompts.
func PromptTemplates() []PromptTemplate {
	out := make([]PromptTemplate, len(promptTemplates))
	copy(out, promptTemplates)
	return out
}

// PromptTemplateByID resolves a template id, reporting whether it exists.
func PromptTemplateByID(id string) (PromptTemplate, bool) {
	for _, template := range promptTemplates {
		if template.ID == id {
			return template, true
		}
	}
	return PromptTemplate{}, false
}
