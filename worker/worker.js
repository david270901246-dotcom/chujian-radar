/**
* 初见雷达 · Cloudflare Worker
*
* 作用：藏住阿里云百炼（DashScope）API Key，代前端调用通义千问 VL 识图模型。
*
* 路由：
* GET / 健康检查，返回一行文本
* POST /analyze 入参 JSON { image_base64, scene, code}，出参第一印象报告 JSON
* POST /check-code 入参 JSON { code}，只查兑换码剩余次数，不扣次
*
* 一人一码：/analyze 必须带有效兑换码（见下方 CODE_HASHES），每码可测
* CODE_MAX_USES 次。代码里只存兑换码的 SHA-256 哈希，码文明文只在卖家
* 手里的码表文件中（导入小红书卡密库存用），绝不进仓库。
*
* 环境变量（在 Cloudflare 后台或 wrangler 里设置）：
* DASHSCOPE_API_KEY 必填。百炼 API Key。用 `wrangler secret put DASHSCOPE_API_KEY`
* 或后台「Settings → Variables and Secrets」添加为 Secret，
* 绝不要写进代码或提交到 GitHub。
* MODEL 可选。默认 "qwen3-vl-plus"（2026-10-31 实测：旧名 qwen-vl-plus 在当前百炼业务空间返回 model_not_found）。
* LIMITS 可选但生产环境必须绑定。Cloudflare KV 命名空间绑定，存两道限流
* 保险的每日计数（全站每日上限 + 单 IP 每日上限，见下方常量）。本地调试
* 不绑 KV 时自动跳过限流；生产环境不绑定 = 没有这两道保险，不要漏。
*
* CORS：现在允许 * 方便调试。上线稳定后建议收紧：把 ALLOW_ORIGIN 改成你的
* GitHub Pages 域名（如 "https://你的用户名.github.io"），防止别人盗用你的额度。
*/

const ALLOW_ORIGIN = "*"; // 上线后可收紧为你的 Pages 域名

const DASHSCOPE_URL =
"https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions";
const DEFAULT_MODEL = "qwen3-vl-plus";
const MAX_IMAGE_BASE64_LEN = 2_500_000; // 约 2.5MB 字符（base64 后）
// 两道限流保险（计数存 KV 绑定 env.LIMITS，见文件头说明）：想调整松紧改这两个数字重新部署
const GLOBAL_DAILY_LIMIT = 100; // 全站每天最多分析 100 次（熔断，防刷爆百炼额度）
const IP_DAILY_LIMIT = 5; // 单个 IP 每天最多分析 5 次
const LIMIT_TTL_SECONDS = 172800; // 计数 key 保留 48 小时后自动过期清理

// 一人一码（兑换码）：每个码最多测 CODE_MAX_USES 次。仓库里只存码的 SHA-256 哈希，
// 码本身（明文）不在代码里——哈希不可逆，就算代码公开也推不出任何一个码。
// 生成新一批码后，把新码的哈希追加进 CODE_HASHES 重新部署即可（方法见 README）。
const CODE_MAX_USES = 3;
const CODE_USE_TTL_SECONDS = 15552000; // 码的已用次数在 KV 里保留 180 天
const CODE_HASHES = new Set([
"ad218268a85bf54da6989f75c4838e4cde13349bdb24cd9afec1842284c26ee9", "aa699ed0f039d961b867156bbca5b23c1ecd54872859264bf1ea77ea76bcbf64",
"054a0697d8c0adc81ca308859890c2ccae728c7129c8c4e333a05aa332cfa120", "d1f3e4f7d545ec33551ca363973de0f3999e5036fb33aef8af1589d6dc80acf6",
"31cefa312c48de58bb61bb97c4ec5b984038a91af8910dfb8dda865507fe4b1d", "308e4888798bb67e250757f193b989d15d91f0fecd3f8d92c9b467e7b62adc3b",
"ead68a15d9b7e33e1c733cd90cb4562497ab5e729fb4937098e01b4c2ba717d4", "07212b727bc600a2d437e9434e29185d046f084b5846d8d2a769f92d28498e25",
"a058bd485dbb7de151c2f0cba8b33161ef03cd318b030de6756fb7b58bdbd486", "63a34dced3d6e5bdd218003a5d204a3c0b8258bca216b57916552dd0cf7ddc2a",
"4a8b0c152b93b549608ef6419ab24ae61f0307bcb01d7473b091aa584ffd66ee", "12301fa6312b4474761a64c02ddddc002d7c859feb1867628f33b87fbc0caf00",
"c342d805a14e18450647cd08f278b4a2644e6ff87558cc75d81411d0e5b202a6", "1bf2fd9105677b5d76b6a018301f1a1e788c62e2069c88b62824d00cc5581b5c",
"559dc4aed41919c84887cf87e3bd252dbc63c0abb6c322aeff822e77939e5670", "a046e783708e1e52cc795a1fb045ead38b469298653e2be079dd4759d345696e",
"340a20ad2e8db949a302568c2a7e93b9d31fcd48153038548a8d4080b4996a86", "3e10e571b9ecd00db2c480ff85ec7eec0cf5d65a647f88fa99fef2cec0897366",
"761cfa9e99afbd3a0e67534efc95cbbd381bfa9e2c9c9790903bd502a1aa4c1d", "f3ab6aaa5b04374cb4055e36c291e6f4c1fdbedf804baa87d29a7dc0c42527fe",
"e1738193770efe3ef4486662a17227e31e74ca86b8330179f3dc86c186d884cf", "90b4e8c3ee84b008149070f73e28c6d67b7fa87def9a3c3272cd6e502bf61fe7",
"0147c533895eeb49d8447e9f2edac1ea2300a97e657da82b37151bedaebc38fa", "84b84973ac3a17bd7ab1442f9e2a342134a148ea4a0dfc2d122ed1a9de4aca9c",
"e99eff1dcfcb5e2c6c48016f11dbeec29321306294e570600e52a55bf11e7b0e", "35b99509e999733137c34ee8fa2b1414de04f35d5052716d34ed1fba56c666f5",
"996fb798e55713d4e61fcfabe65732844a89568cc25d2212ec8b0828a2a23115", "13db158f854b4081569657f26dcf456860720694a9b81321386a8e14323891a5",
"51817a1be152dde644b9dd40d62c254a5410263a6819ecc03d4fb2cd6763ac04", "22205b36de14477ef4d778a62cf05f1752bac6397c5209c19a29d1b6660d92d9",
"1db1cc12432297644ebd8e122635f9c69ad175af9989649dd57e4b635d31166e", "a246f5c2dca0add383fe902b55c43eeab7defbf6b3ddf8625321f2a45d7d6e45",
"d9a140d83dcb754fdaa2c16d9fae0eda42535941b55a793ae798899a17792211", "01d1f9fabc53c92e631755ba325c3fddbddc963c931f3a28ca277ffa0ad5b72e",
"07b7d30010e3d8b67a9d28696e6b22494059853fc4392d1b09ea395efa843a0b", "a2dac8ed0ed7ba3f58f79c75c52af40283fd50f94a17d74662e2ab156e83450a",
"75c971d47d81044becccc6293af50c06f98580b61d8124fe3e15044bf1be8707", "d956a2501c5a53fffa74804b354d9c7530dca08d1bbe4768e2e8a04229ad806a",
"85ee067a5014f0f792810e87abdc8621a2d56f94dd7ffaad0be971cb3629fcb8", "9b18155e516c3af9e324297c66f97611060c7c26b2a931406e2827347f6845b9",
"d7ad1fe38dbb6da599687c922a928a92fa6a2a394527cff2f24e6abadd8ed895", "c1e5152c06474e60c1fe860d6b42e2347bc754cd6bc9cecf4b42615b23059f09",
"ca45b8e5feb4e1e97854b2629f2f27975cbf22de47a66f8787c18012b923404e", "2e74cb519df8af22632ad65d52317b1ab910803d3590de1f1ef68df9e7fa35aa",
"8da51b2c91b39518a7e4fd94aec9726571e3332752727b9d71d046d4a523deef", "6b6af266918b43da7362112ced1046a132a53f2f15fbb3fc6251eb5105ac53ae",
"fe2cdf1bbac9b150398e0a471877bd1652eab447d37cb6f04467070d9445e2d4", "dc7896c11b0d6564f2d0e83dc7c7c64ccae5cd4f96f8af4467494d62bee6f740",
"4ce7fd34176b74bd618ff55112dc9fefab7e3c32472459f6c30057cb19edd0fe", "af34d0e110ae655a64153c6c4c59d39b09dc2a1c99d728cefc93af86adef894e",
"bb075f318f23f51aefd5f7f5be219dc57ebcb49e0f94516b7eaae6a558686393", "b7c952d31a6582372f56272e18e9cf9f68c994e10d22f205c418bd97b8ed7155",
"476baa464b15f9da2d9bd87978c640dbc6c2940be0e5c85b64c27cbd96f10c4d", "3688a59cc5999f3de70465437371d8a52815a2ff32be60bd5951e9df2b37ec9a",
"672beb1b72efbcc9fea4eedef4cdb2924a1ed0b93c64b3cdcfe15f4355b9cc51", "c125ecb3adf0a3a424b586aafcbe9d3c4856419ed7b8200542ee6f5fc197edcf",
"dfe312fc95fd884985e96f9ff160bd868564297946078ada690aead6734ae06e", "6450f9b386c5684006f914be8c9b6cce6ab9007a1bdd21da4ce5630218105767",
"aec62ef26949427ea0e138969c06621fad0575d93e552604508a09f1c616dbf8", "2b66c7bb4d476dcbdc240c1fade8e971354212c02d71a804808dc391f9a2921f",
"7545532b8c992ee2c3ed8ba0bc5410620f144bc809df1715a9d34e9de601e8bd", "add915ec0d93db2455071e769b50d1db93ca5872929f4d5357636c17a1f77312",
"7b460d82008ef28f16b06f6673b976d524019ce070410d8808c5b62ff1874f7b", "57bd573e2ae979060abf84e4198a7bce0ab93256f2975464ff8407cdc85eb08d",
"be12d6ed53773f7647cc05e5276a7b22bd8043adfa749b5cd8452f534d464095", "1fa8a4eae6025822ccd9a6bb1c74f742984bf1ce5c8ef6794c082b65690db35c",
"c7c0e553e0ccab853ff42b8c69ea779555992f61b5724cead7d8972c2d2015a9", "6a93ddab1e43a546140948abe7fdf122d367effc8a1d1c6f5e9c3725db2331ab",
"19546131e6b697c3c696be9ab0edd7c5943831d5bdb56e9d9ce1a3c196b91be8", "272ad0c998bbe85a76faac142b08e42e4e5c3f072cc74923ea52daa29ce3bbc2",
"6914834c5299a2791bb5a0c9466c7a807c8536316893d043133f48adc90698df", "1ae9f9b061ea50e9c1a2d3e5d62e78467fac37d87f0b84a8b2fadf33eed571e1",
"c5739b66bfb1536ea3fdaa163fdff8e94904838b8bc5a2a34bb3173e5b92a533", "6713c96818084fe856a1403bc0a91b792498b48c33b591b9449ae96261ed99f1",
"dd0c0c43e876874d2ffa27d0e839b4790f1da86b331f23964eefaebf987d9f9a", "1e3c627b1a69ac96b4087160d5a9e4f983f48f3b93d51566bb0582995081a4e6",
"0a6e9b503d6950e277a5e0396ef68b1cebf41fd82cb1f2adb27cd9f8192367a4", "f6fb21e1a0017c139825770e2eb71b980576eee9caeaf49f61bc25355d034848",
"768222bb94b02daab01f33f2518ccf1ab8b0404f5ef76d24910ddb9f1b6ab2be", "ca3fe820c6db6bfba2877e2c23b588108bf59239b4be264f6dd688bda36cdc02",
"3ec0b1ee54c96c121711c699a328ef720a27764e1b64ac7f6aaa5f9d51a6e9ac", "f9a2818b7380393370d764078549e9c98bd390070b4941c4c66ba34e8632aa4d",
"2d0f717d3c0025ad5d9cf6c8fd0d44c7e25bb0ecc73ccde397874a9bef317998", "c045f63e43de54deaf08b0e4682eef83750a272cd080d143f672d73b29ae7050",
"6cdfa4a27c7b67b88ed6cad1b3810351d5c65bb8585e92aec0a987d77b0a36f9", "e7f9bb40db995cb42aa20d699d6767ff471fe06c4c5c8ec47836ed91f6af84a7",
"c9b4ab598ef98e95046625f85541aac5364ab3fedb37de546ca2bfa987dc9f39", "d9a82e68be3faae7623ed87052cb0343d804ed2b4c1ebabbd9d82583aaa56dbe",
"db41b2bddc88f8b9ce0e1cec4cfb2c9b5ed611c005d40a4ed9b5bcb8defd31bb", "f3bd732004af2b75d5726df9aae91658c467754b779d2bbbbdad959545fa7128",
"1437f410cf086b5cb4a47b6510c6381c2671738c00af78f7257bdb8c89c9cdd8", "5b5f9fa28c08453fb0e8fcc6e23703beb9ea7129b18058cd5396ba10d378b6d3",
"8be743e9399512f24fda7f47929a7d388dc0b301cce1c2aa8ba40da313f11d7b", "bfb1fb0136270085da450c21a7023a6b42d0ed88f7463580ce89a838f7c1cdb7",
"2969d81fadc1259db7a8fb13d6028b57b7b3a915bfb2c4566b3b0d9acb6186d9", "7972abee59ca4ff907a165fbf308268bfca8ccfea06d68269e6358947cd47b12",
"b0ce06536c3593d760e5e28386499d6a8f1e6fad0dc1cd2cc888171bf7218429", "dee1e01f309b3f757c245b835c09aa6892041dc84dbc768b94c7afe455ab5ab5",
"fcdd552ca25476a04952857de5506b9c5d392b5b76ed662a95f8b0992abd3b1f", "a76e5e65d17be046b8d41be2e29072ecce730cdd4cc23f07137e53bf8380db9b",
"373bb29a7a55b8fb9823fda57439aa2aa3c12695ce04b50cd48ffef187c9b916", "439464c5fab235de757b177d03f99f212d7983b0f0edf7edfad6d0c42b560f55",
"a23e6bb05b93a0c2ae74bc6a447436321475c06674b0e7fa47e3ddf52887824a", "e93c5ff63c0530b6728cb8cfa35e5e744618dfa0262ded6cc23a86d1a6f6db25",
"6a46bc2ba5f337312dad1f12a520ca20aeb13333903011c6e4de994d83e57248", "f81930845fab0e92523c9117e7bd6fbc017d22d5dee9c5ed0028dd7b3819ad9e",
"bba6c9b8da389ec8fc5b203f134bea9806840b685c5d9d6e39ca0755d6b6c050", "06f1a141eba883c439f81f8bde5b5eb6d3ae4b99252d77087cffb8e02bfed0c8",
"806cebf65fa415368571c94aa8991e49b63c21e9b9bd30b0667bc547a3100b28", "e326c729719cb93a3e1e1714c41c2d82a2562a98b66838cfa8693bbb225abeb5",
"26fc878a3899c2fce167480b8a97efcda4802656ebc41ab501d96d0b0865dfa6", "f983392dcebb13a65a8410be369c73d7a53dd2de03ab55e458dddc26454107ee",
"df9ec418f68d51d0f51fc05f366993e6e269f376bdc28babb59ce60fb7d1dc3d", "9a015968d50de1f46052b6ee4100c9a06c7b8bd679dafa4996002864aa0fe4fa",
"f6fe19910621195442fd77e383e52a8d8956243b2d984ea4d2b0ce8af9277a79", "f5fc3c94499708ac60bc39d6e66bdcb073e432100734a4b5f91279fee75c4407",
"858129d8d38da2e729c367cd1d91171287102b27f2ecc83647f662672223a11d", "f90853f57f64b9803da67bc23983a9a6b981b6bfd99a0ab55121af28f8d5d05c",
"de57dc67e671b26ed20fe367ec16ab5e943be485d4a610d8d6bdd83afd68e62a", "581f0c6a6fac81fa68b827700d4557a176cb5878bd682ed14ddb94c03765b164",
"d5748b949b92de6600562284180ffcd9b5d7c118bc44f78ae40a194f31fba513", "6fd3f5916a2fcb6c6438db28c0343d2c56b350df3c5518e1bdff831c4a596e0a",
"30bb6f804840b080c80aeb41a3ee781418e3eda0533618c0ba4298e29a8ea493", "a1dd601565e7814a50e1bf9463abff71d74d71e8570174f6fbe95a2305fa7b5c",
"de946f4c588b3a0e34bb3260cae3b57a4765e3ffb88a5c55bfcdb247b5d260bc", "bb58f64205802ed03bac38c61dc8338a7954315dabc24c64b373275e2d7e8f6d",
"f1092816b80e7ce40c5a5ea82347e73b910c3bc715e34e2c2c759e38a4271e76", "3df57d7e4b3d92f5d252c4011412115a601f426d49c5f8b5bc04ed50cb42b0e3",
"ee385bb602099c9b75fa8b410efc56ed13f4381c9166307ceb8136518d096413", "13752993667d10383862309a2b5bfd6423075330df77fd19791b03a1c4761b60",
"709798aecb5c6d69b6d66870b8ebf7ee223b574b127b7de35d72d0a656a43f7f", "9013672c6b6415aef0edbc88bed4e6145647eb26b328ee870a63dc133f13d780",
"de836bf1c0211bef64fa8cd7f7c5d5416edd9768ccd37e9574b960fb2f62e25f", "63b5bf70ae6780b1711b43721b296eaccdecd478f58090b06afc20fba603d6b5",
"e3e1575ea67ffcf7f5c3dcf52001eeae3dc13a14ae6bcce12f9b97653becad8b", "8cb88de4810285ccbc691fb629221a2c111be1696f29b2b6d52b70584381e91d",
"7c9ade7800b6a8e1a5666a4354dc16b38be59894eeba30570d7474116f606750", "8fe3e2e9cf3a8a9ca2d5b0a790cfeaae7c2053e969bd1549e70a0f41a917b890",
"11e1a87abb997745526cb0f9bfad648c2adbe91495da5c84b95e0ab40d5df9f7", "8a08404a9f26f048f5831e3c3795fc6b5f3e6bc19620f5cdcc817e1282861c30",
"41ec6d74167534b08d65519b590a96fa1b8daca48a35393b62db1468be40e9a5", "a90b18c4765404f27bf157c3a99e5f432d491ae7ce1d419deef61c5c791a3461",
"45b1a06b3f3d2c87d5773fea20fccc9c25fee0950a8ccbc30e43dc9facdef7bf", "09e303f2c7967d5e519a9a752cf241a350093c3ac8a2a985d8ca61ea24681f68",
"1fde0afce9d8c8d778fa1003eaf621e1a084c79b5e5f042c4c8aa2a6c3d6cba2", "188917bfdf86f1b510ea447986aa9934003032b8796793f11ac2e4715379342a",
"0639202c4f1b5d0e172a0852996addc692200ef7806048b81172daca37a3da3b", "eae47de740f64275673a60d5971af374edf52fc3aee995b22c9d47998479f244",
"bd7ddad17ef65ea0bdbe969337c96896be9fbd1b08774328087c08a59edf11a8", "de8906f98734cafc7c580209f9e1b5f38b9e03d715385c64e4a04bca6acbd651",
"14b89e5a0816b03ad9bfdb68ef6c43b030cfd5d09db8a89acd758af676f9df25", "2ed61a39d6b07f7009c54db382f24b27649c8a47e489672cffd21687207d4df5",
"1d41b584239b28e15ada073c0e5c289d7f26409536639874d6bca2977270ea00", "6a1a5c9712c133d6ac11f9be580b8c838ffb9eedbbb33decffd59eb18a35d858",
"08237d6e73132dbc55dcd4633f31d06475bbe0302b1fbc2144c3bd0601b17dfe", "f3ccc86ca96cbbc822f8241f63357853e9ca8f177d298d92a8516356a9b58bce",
"c351acd44b52d447c38f3387d801c64c897e482824fe9e9ac42a5551e4bc4f27", "e0243f8f89fce8cf8ac71dbb40da1b4d9868e7a6b422fb57fe0f12a68d8d35a6",
"ed3d069763d4965c54faf16a0e070b7a6a0c01541fdfa6ccbaa9ee8c3f433426", "1a6aca0b7909f9e031398a3329527901abf916a849e68f2ae174ac6343e773c1",
"6b3008c1f2f49e393514ef8ab18f406bc117ae05e93a5999ae941f9db7336db4", "decd1d4b6d2c16ccdd3bc5855fa480733b5929bb2e7ce44c7075cf7a46a20868",
"c9927c7c256b94a1cf47258c66f2d5452257c233f75d63d053363000ad852b1b", "7529279b423830d9280237c19354163723cf885c332480c0837b8aacdd658e84",
"2fa1fefb1108011f6d4cecfab9bcc86179334d16de7a1b36b50ba26e15683020", "bc2a2705e5c8b78553e4ca56169d2094e24c271292f3d9dd0ea2f4eda9b92da9",
"0b87388565dde8cdb90240c8bf076ddc60a2fa44eacf431d112ef63cc898d966", "4d6cb09d3c13a053c8d85961773791dbbd2c2eb24a8a0e57164f72d972d5570d",
"c3b9d73a39d444c8f863cb57b2847beb9701a179d50d7f381deafd908881ee80", "6dfd31c9f19684b8b22ec263d3f0dcb3beea06b3257bbae802e177169fb28b9b",
"909c39fd180343ae7126a2fc43b3b6ff60afbcbb3ff98ac57af9f0d1d6f4dbd6", "ef8337ac836ee3f1bf8c5a22af4ed49436f2177a133450ec539f0d31ceb925da",
"d83e7bc4120f554b96321aa4952f8e2517bd1449d264bf28e6177795132d197c", "76487451d5a954c1d5e9bbaa36f81c030ee205083b89ae0785d23214e817d467",
"5b08a5c889fcae4d58f3a5abfd9480616337130a4ff036aad827bd2edddc1916", "8bb56976bf96e61714b3e76e8d6f1c39af536870fda7e3ac590fbc649cb83ca0",
"68413286201db346eb6985b7e86f5d8b1a29aa28e17f6049770232378a09b7ea", "c9122d25e865a9e06fe63c49687775aaeb5b58d0b555455d13379094b1fd8e0f",
"5c86d53a1db5086e9e7c553410a7cff34e67332fee4e9aa5c921d8a102803948", "6bf4ef5f04743a49259822700d84530d6029a37e72840dd5d9eb6088df243724",
"913b905a368a2b381dcce515462d1b0cd32b398d82d7b5c8ef6a69c8122bf200", "c99074cb264662e2398943f60586afd70035a182b287bd71632f0f841b86acf0",
"37313b654dabfe0a8bfc933e2276469069b9f8fc9e9ab873236a10b036f6e3ce", "d55ef5d432e2e749227c17f0a526c27ef4d4f89829e146c0b9d0b9c776362f76",
"79d3ef5889b947371250f111ed26c8df7f93a0c1495eb6b97236b72022080a3e", "bfed0884ba77da8af7cd49d10fee19f018d700db075f4776fd2231e106ec9874",
"aa9711541e386ff46dc20b3e6ada1694740b1314b1a3fb8c18e42d5f38f486ed", "2a29392947e3a831ea6f3e89abe200d084d03ec92010fa80234df260cb869c62",
"7915450df80afdcafae890255275947846aa0aaa78d51d43e8e047b2229904fe", "fd69697a59237f241f4be54cfab8f181530d2d778cffe1473a31bd31b7508263",
"fb00bf575ed47e0da740ab054acf505e788b0c16d8d73f2040fb200d940e8098", "eb14bf08694782a69cb44543b25f024fb460d36433c0b7d8dcf0287d4055c844",
"c965a14d0616b57100d76a8b890c5af0867366ac4322f7bc09461da07c1bdae7", "a677a64ad3a875431e26bef64bd5b225c64be1716fe57319a1336d863b95cc49",
"75dea5bbca32b7513a0c7071ae09b1d2b4f6e912d6d0166a0d86a5bc306b0e0a", "c12eb332497ed062419d9964dcd0fb6553b4422b164581ddbe29212da8a58b02",
"693006b63620673255cf506672f9e2442cbe6e76de533f87362cf2f02e29325b", "4cf5bf1ec244ef8ece56a6dc6bc40c94d803c636573059d9978cb0f90ffe46ee",
"6cfd6fdd88c89db729a8ed0a4f955fd8705ab0a899aff36d5898dbfc172cdf87", "7c374645928e7014c387220331da7d29e7d7df9529689ee140ac45743efb4e2c",
"d6e1d522832d203c4f9ca430f5ca9ce343d7bcf88e804243fc5cd7958432c372", "d19d118d0702a0606a943413462aff2aa50d33d57af8d3dbd45c355e7cc61b54",
"8525af54a5be68d3e5630ca30a9c66717800e339dc84507782fa65587770b6a0", "e748e6ed459581214c2b263583074b266469a00715f62a48995f4ec5128b98a2",
"c83f8e85155a1a1927b490e6af6f598373f20ea64814447b324c3d9963871564", "c1fdde5a1daa6e8764e72c6938089266d173d4f7e496bd0d14b8a887d9c50096",
"02fc33d7e87cbce60e87636e85e4b754272c6c00afa4714ad91e5c2ad24f0628", "3ea01777e10afefa897d05013dc54cfed3f5cee6d10facf1ec0cc614e1e7c338",
"a2403daca6abc3a3ce4be76317c0d3f3111e6f0b5b24a2d602d837638cfa0255", "82d207216c151b96a5db8d019fead82a296a80dc30e2127df6762debbc6f9706",
"aedb0931a884be574bc9bef8c460df82c91bdcd7f27c84c181c3f087236216aa", "81a1b05853e85ca4007b613951ad1ef1a56fcf5638125c4e18e48e9e727bf8c3",
"99f929d48641bce73f545ea0f23556c55b98377e74fd943701fb617e8cd3021f", "0d9e9a953edeb47942a466058ee8bf1e898fc8f7dc7ac499c9f9c373761f33ea",
"0982963031c7822c6f3b113a51f6786ac29edf1e44e858398d5013da4d4f636f", "5975f82ee9b2ed120984c3dca074b8bde6032b66b77048ba8e879c5a97c75d38",
"42478742564a5f4b0be75375beaff58fbd6e0afd437be3ddbe7486f0b1280222", "46d65ac8a298020ad0faa8ef4ff20857c09d8c85d51b43652bb0b5a6052309ff",
"9396b65b82ea7b0525d99f043499eca12325e5b2f2fcf750137eb2af1f4780e5", "17c4c5eeb90b1497c6d966966637b36edcf1c3ad371a38b8c4bbdb7896cbe4d9",
"c6404d5528584e5ccf7ea5b197ef50368066da58052bfdf31bb3514078af4479", "41e495194cd337413760b03b46d515b2d4d0ab7b9a884e01ca2d24d5b49b0009",
"d49eb33e96357bead116bf1b0f1e21d1a018e3e73ff312afecb6f87cbf7b35af", "6532aa53c97c5fe5a66dd833c66585b8fcdf013f3a0a3a47ab7f1c35eb166ef2",
"abf8194ccd3b5deee9bb8ef18cd5d3a768d78b46f7f1481d2f08229b3c886806", "024a01d298a7b86d260dbd83648a21abe9ad9a3beee691c50549da2d632c607c",
"ec61c8fe1c1e694ab5f0306330ba19f6c305302a689ff7887e27fb4b6540c442", "4b9bf73671bc69a1f3ffdd7d656b05824613baf51e607ab10d7366d51d25dddf",
"b688a590ee434271adc6dc9bdd04e2998dd0b76e7f7f98011489d48f30f04456", "bc1631cb1099ce574c40a9d511da6488c738644fdb5ee8aaf6e05af507c0f322",
"a0fb4487f8396515ef26899a04f0251913f6bc49ede97fabba3ae063028a593e", "87c558836b441be37ba6ba039435f117a92f7115508d260f27a60fa02487b2c9",
"0ca06356b9480a96a81648386190053ea88151a78cb331f899afbeb14fa1cde4", "14745c658b07a06080ed7af9b142e3c9206a39d6f1650842876ea52663340355",
"69a0f8e07d84084322e2852bb1fce38cb6ff795150a00955b56f6bbc10730e1f", "9a5c8fb7b8df72f567d856fd575df1e5913c30b2afe0932e77d81ba20a33cc45",
"5136dda419ce4e48c5a71db8d33511962ef9071079088a11e8105c8d54073af4", "f75e7f7f97b7d1ab7247c85f709b54a685309feb094aa22a9a70e2c14ec079f8",
"b96a06ff731849f997795dd6c9d1a7dcf6d92b98f095a650fab7e5ee49a882e8", "40859535e00a55ab13a2b47015fba1f6d5f87dea9a60e0fd5215a6b63eb52fde",
"9727980c58e5db460be90e12aba6684ccbb2f1f5264e5a70fee136bc9cfbe097", "ddec9801dd572baa9ffa4271dd76b8fe06ba7ab4ee54d355fb79cfc9afa1d489",
"39107788d3ccaa6472e4ca4bc16c601182b8d48e34d55c2a40114ed32877cdb5", "84422016d83d6dddd918e32f576227732ef76a3f92197660da53a2910f6b320b",
"0236bc8c27a7eb3e36c583225af02d9b5663300f30e296ec598e0920b2cb050d", "5c30641a9d0a3a99b91c9a391db4929b65864170b5375c5d8f63ea7469358e4d",
"42ee2c658637b3655b7275e87d30f98f7efdc5fbddbc2cdca46ce8d488c88184", "9229b84fc41d14a79ab5b084ebe77645e4c6aaa78c99315ceacd115796b0fa21",
"bc61d42a6171fdc8916edb60a2a468899db7e9fb785f561efff9fca644d66940", "8edb6895f20b345fd9ed7f73caa9bbffec31c0121708d5fe31ae42d5f9c391db",
"b1e3674385fb173fbca5f3b4bebbb2ba24694a9f6351795a53916d6913f73123", "37ab866bfd4593835d4acfc4e479f344b279c1fc249a5579d65453b18e87e3bb",
"5fa348a90212be41373790cbc1f7931d5df2b6a2c740732ccab310d8e837f3d5", "b38cdcc964ae68e8d920db94dda7df01c90155daa686da015f98cfe014d1589b",
"b53cfaa57c4def74521887aad33e925eee07461edf5489fc542a68f203cf9f8d", "c02dadc013700e96bc9c064066faffc920307a0db35a923e1847681c4a962a35",
"88d7811e5f72d3a7b88158625dfc2d4e5536d8c625c430d7b7983f69dbe32a8b", "a9b44c29b90fd2c4e893bc5e387135e7ae22ce534399a8cab4444d66977383d0",
"7ef61741ab7231b7ae46cc8198b758a25a294a0f773751057b361d6c4798f155", "a9fe0b9bf3bd4e2aad166ca11b4baedb8e3761babd1e249673d96044d7b003f6",
"57961753980a559212f31b213615e5e90bfbab4ad322af0975b77eca6b803e8b", "95deacf1a24fa93dc2d38ec9ae74187521eb50279b232549f474fb740c3c4dbb",
"82d33f2b2884d84ca8254a3e40ae9c9f543d6fcae337e7b23114fce35651d629", "1cf574710340a2ea86ae6be186082b0101d30347a794f0c4e0304ceec9569d53",
"c7ff9603653220abad5f66a1c1db691fe133d4e4c5a0a62779dcd61f59a4b489", "b30a56594ee5444c2dce2a6cb7d2f3658eb9881864cc23e5ccfa6f3435317542",
"1d51991206c948f55d50186c1a5bd384c44bcee1c9317ae96bd8238731e6762c", "9d3eb82e6f655d32785bb8ce4473624c8ce00a1035a36e032f6e039fc1c58da3",
"24ace9e0d84554162aa4fbde1c14d71b9fa0dc6f7451e9b8d896bf1650cf9be4", "b86a47ba96b1ba5889aaec2bd0227671874eea74c0d37ec61aa09f2bd24664bd",
"b51f1dea68c81699f52921277b40a8ec0d16af86bb5f7a17925f155402666121", "36cd3d3bebee95b6d96818512b5d079d84c055b4870f03c4276be44131a05d0e",
"2dfd6b58e009f16659ee2466b93f00276e4a51fc3978a90f0ed97dd70fe76852", "413cf94177bb90e3de61fe81ae83d8abb686a1f5048fe8d95ee5ddf5cbd51cbb",
"9294f6f1f1ae397336d5c3c70a2cd0ed4462c3ad9a9269d455c817048d3499da", "1bee8e7f42e1078fbe9e947dc6d710ed23710b786b2d1d6fac54ecc385ce169f",
"501cd984f8045fd270e7104fee403738d6c01167f44b53569d157034cb3ff94f", "290803258f3f81a136bffaaa9ac8e4d2a2286c7cf53757e5b9731c54a87c9f81",
"95fe28681a8faf15a25097adc1d2dd41ecab70937d4d221ecebc97be7752cfd7", "5437f4e095dfb1308b881e51f3a8d8df14f0c059062f0db8de5f9c5bc92c2921",
"8dcce92d44f9b5c86d750e8223ead77ac7994ea55b1ffa73c7099cd2022860bd", "cb2217550c84d39d83fe7198361797fc26d17530f7808f6acb6cd01696466a12",
"700c0067d3a3a3c18b4d992dbcc90a0c0d91ef0ad8ca0172a8b89cc597d36a1d", "f122e9ab5cecc39269eed6f3937a1f445ddf68343627e7544af3d17751dee07f",
"3ab67a9ae9d1ae11b21469da76492fd3548894e7fc9f818372c851a4ec23545a", "720e644a7301634703a311a01312e9c73bd95dbe627369b43925268faf6d04cf",
"b3203daf8a211094a887c20db5f55c49658d43be5f3b77279aadbc61860b3f29", "be0b92a2c896f67517e939a5c3276e14d02cb99b4093b343c178c34d11e98e02",
"05a4ba41a818ca0e09b86d1bd3f7b6f327d78b3317428528567a98b420563180", "500171e61f1449f2ade04576e326083eb81319ae25598b6c515db6bc606b016d",
"7cb2c237f750d72f9839c85428e68a6fa1cd9f74e68322f754e77d7855985071", "4829ec06fb918d0277681b9dc0f5d04fd7e8a7e87b8ac845be4607a0094431d5",
"c2c26bd60bc7da4915156d06a81b6331049eb2590b2a5b1a5734e69d43d9772b", "4b36c0213ae4e8725c80892c6bc662389049c31b0485dc38cb40ec0d49714cac",
"850afaa12727850a48eced5feb314cd76930bf00a8044477401ad4335ef5999a", "1a0f582540f9e0244c9de81a80f4d43ae844bf515164afe0747bc7e609ab0e31",
"cbae03e82eee4e74ce48a577be658975e264682b7da36eb5b8db2eee6802e7c6", "8bcdfc94234d73196e6a0a367319f33f1011797048c5d7f536d6a631d28c8259",
"af62964d790b18c3e3c72690832482aa6bfac84c42020a10cbcb380d8c67198e", "adf2e309ee7cc1a9afd5635fe0a3d1f497c7cdc743bfa20d446cddb6bbeda3a5",
]);
const SCENES = ["初次见面", "求职面试", "社交聚会", "线上头像"];
const DIMENSIONS = ["亲和力", "可信度", "专业度", "好感度", "接近感", "气场", "记忆点"];

function corsHeaders() {
return {
"Access-Control-Allow-Origin": ALLOW_ORIGIN,
"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
"Access-Control-Allow-Headers": "Content-Type",
"Access-Control-Max-Age": "86400",
};
}

function jsonResponse(obj, status) {
return new Response(JSON.stringify(obj), {
status: status || 200,
headers: { "Content-Type": "application/json; charset=utf-8",...corsHeaders()},
});
}

function buildPrompt(scene) {
return [
"你正在为「初见雷达」做第一印象分析。这是一款娱乐向测评产品，核心是给用户情绪价值：语气先肯定、先夸，再给具体又温和的微调建议，绝不刻薄、不打击人、不给人贴负面标签。",
"",
"本次场景：" + scene,
"",
"请只依据照片中的信息判断：面部表情、眼神状态、着装、仪态姿势、背景环境、光线与照片质感。",
"不要猜测照片里看不到的信息（职业、收入、性格本质、健康状况等），不要试图识别照片里的人是谁，不要提及任何真实人物名字。",
"",
"从 7 个维度各打 0-100 分（整数，一般落在 40-95，避免极端分数）：",
DIMENSIONS.join("、"),
"",
"同时给出：",
"1. headline：一句第一印象标题，有梗、抓人、适合截图分享，但不冒犯本人；",
"2. gapIndex：落差指数 0-100，表示「陌生人第一眼的印象」与「照片主角真实状态」之间可能的落差大小（比如看起来高冷其实好相处，落差就高）；",
"3. gapNote：一句话（30 字内）解释这个落差；",
"4. dimensions：7 个维度按上面给定的顺序，每个维度包含 score（分数）、read（一句话解读，先肯定，基于可见细节）、tip（一条具体可执行的小微调建议）；",
"5. overall：一段 60-100 字的总评，先肯定整体印象，再点出最值得放大的一点和最值得微调的一点；",
"6. shareLine：一句适合发朋友圈/小红书分享的文案（30-50 字），带一点自嘲或自信，末尾加 #初见雷达。",
"",
"只返回一个严格的 JSON 对象，不要输出任何其他文字、解释或 Markdown 代码块标记。JSON 结构：",
'{"headline":"...","gapIndex":0,"gapNote":"...","dimensions":[{"name":"亲和力","score":0,"read":"...","tip":"..."}],"overall":"...","shareLine":"..."}',
].join("\n");
}

/** 把上游模型返回的文本容错解析成对象：去掉 ```json 围栏、截取第一个 { 到最后一个} */
function tolerantParseJson(text) {
if (!text || typeof text!== "string") return null;
let t = text.trim();
t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
const start = t.indexOf("{");
const end = t.lastIndexOf("}");
if (start === -1 || end === -1 || end <= start) return null;
try {
return JSON.parse(t.slice(start, end + 1));
} catch (e) {
return null;
}
}

function clampScore(v) {
const n = Math.round(Number(v));
if (isNaN(n)) return null;
return Math.max(0, Math.min(100, n));
}

/** 校验并按固定顺序规整模型输出；不合格返回 null */
function normalizeReport(raw) {
if (!raw || typeof raw!== "object") return null;
const byName = {};
if (Array.isArray(raw.dimensions)) {
for (const d of raw.dimensions) {
if (d && d.name) byName[d.name] = d;
}
} else if (raw.dimensions && typeof raw.dimensions === "object") {
for (const name of Object.keys(raw.dimensions)) {
byName[name] = { name,...raw.dimensions[name]};
}
}
const dims = [];
for (const name of DIMENSIONS) {
const d = byName[name];
if (!d || clampScore(d.score) === null) return null;
dims.push({
name,
score: clampScore(d.score),
read: String(d.read || ""),
tip: String(d.tip || ""),
});
}
const gap = clampScore(raw.gapIndex!= null? raw.gapIndex: raw.gap_index);
return {
headline: String(raw.headline || "这是 AI 给你的第一印象"),
gapIndex: gap === null? 50: gap,
gapNote: String(raw.gapNote || raw.gap_note || ""),
dimensions: dims,
overall: String(raw.overall || ""),
shareLine: String(raw.shareLine || raw.share_line || ""),
};
}

async function callDashScope(apiKey, model, dataUri, scene, useJsonFormat) {
const body = {
model,
messages: [
{
role: "system",
content:
"你是「初见雷达」的第一印象分析师。你只依据照片可见信息做娱乐向分析，语气先肯定后建议，只返回严格 JSON。",
},
{
role: "user",
content: [
{ type: "text", text: buildPrompt(scene)},
{ type: "image_url", image_url: { url: dataUri}},
],
},
],
temperature: 0.8,
};
// DashScope 兼容模式支持 response_format；个别模型不支持时下面会去掉它重试一次
if (useJsonFormat) body.response_format = { type: "json_object"};

const resp = await fetch(DASHSCOPE_URL, {
method: "POST",
headers: {
"Content-Type": "application/json",
Authorization: "Bearer " + apiKey,
},
body: JSON.stringify(body),
});
return resp;
}

/** 今天的日期字符串（Asia/Shanghai 时区，YYYY-MM-DD）。用 Intl 取上海时间，不能用 UTC 日期，否则北京时间凌晨会被算到前一天 */
function shanghaiToday() {
const parts = new Intl.DateTimeFormat("en-CA", {
timeZone: "Asia/Shanghai",
year: "numeric",
month: "2-digit",
day: "2-digit",
}).formatToParts(new Date());
const p = {};
for (const part of parts) p[part.type] = part.value;
return p.year + "-" + p.month + "-" + p.day;
}

/** 访客 IP：优先 Cloudflare 注入的 CF-Connecting-IP，其次 X-Forwarded-For 第一段，都没有用 "unknown" */
function clientIp(request) {
const cf = request.headers.get("CF-Connecting-IP");
if (cf) return cf.trim();
const xff = request.headers.get("X-Forwarded-For");
if (xff) return xff.split(",")[0].trim();
return "unknown";
}

/** KV 计数容错解析：读不到/不是数字一律当 0 */
function parseCount(v) {
const n = parseInt(v, 10);
return isNaN(n) ? 0 : n;
}

/**
 * 两道限流保险：全站每日上限 + 单 IP 每日上限，计数存 KV（env.LIMITS）。
 * 没绑 KV（本地调试）时跳过限流直接放行；生产环境必须绑定，见文件头说明。
 * 返回 null = 放行；返回 Response = 已触发限流，直接把它返回给前端。
 * 通过检查后先把两个计数各 +1 再放行：先计数后调用是为了防刷爆额度，
 * 代价是上游调用失败也会计入次数——这是已知取舍（失败重试会消耗名额）。
 */
async function checkRateLimits(request, env) {
if (!env.LIMITS) return null;
const date = shanghaiToday();
const globalKey = "g:" + date;
const ipKey = "ip:" + date + ":" + clientIp(request);
const globalCount = parseCount(await env.LIMITS.get(globalKey));
if (globalCount >= GLOBAL_DAILY_LIMIT) {
return jsonResponse(
{ error: "daily_limit", message: "今天的分析名额已经用完了，明天再来试试吧。" },
429
);
}
const ipCount = parseCount(await env.LIMITS.get(ipKey));
if (ipCount >= IP_DAILY_LIMIT) {
return jsonResponse(
{ error: "ip_limit", message: "你今天已经测了 5 次了，明天再来吧。" },
429
);
}
await env.LIMITS.put(globalKey, String(globalCount + 1), { expirationTtl: LIMIT_TTL_SECONDS });
await env.LIMITS.put(ipKey, String(ipCount + 1), { expirationTtl: LIMIT_TTL_SECONDS });
return null;
}


/** 兑换码规整：去掉所有空白、转大写，用户粘贴时带空格或小写也能认 */
function normalizeCode(raw) {
if (raw == null) return "";
return String(raw).replace(/\s+/g, "").toUpperCase();
}

/** SHA-256 十六进制（Web Crypto，Worker 运行时自带） */
async function sha256Hex(text) {
const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
return Array.from(new Uint8Array(buf)).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
}

const CODE_ERRORS = {
code_required: "请输入兑换码。购买后会收到一个兑换码，填进来就能测。",
code_invalid: "这个兑换码不对，检查一下有没有输错；还没买的话去店铺拍一个就能拿到码。",
code_exhausted: "这个兑换码的 3 次已经用完了，再拍一个就能继续测。",
};

/** 查一个码已用过几次：没绑 KV（本地调试）时按 0 次处理、跳过计数 */
async function getCodeUses(env, hash) {
if (!env.LIMITS) return 0;
return parseCount(await env.LIMITS.get("code:" + hash));
}

/**
 * 验码三步：缺码 -> code_required；哈希不在名单里 -> code_invalid；已用满 -> code_exhausted。
 * 返回 { hash, used } = 通过；返回 { error } = 失败，error 是 CODE_ERRORS 的键。
 */
async function verifyCode(env, rawCode) {
const code = normalizeCode(rawCode);
if (!code) return { error: "code_required" };
const hash = await sha256Hex(code);
if (!CODE_HASHES.has(hash)) return { error: "code_invalid" };
const used = await getCodeUses(env, hash);
if (used >= CODE_MAX_USES) return { error: "code_exhausted" };
return { hash: hash, used: used };
}

function codeErrorResponse(error) {
return jsonResponse({ error: error, message: CODE_ERRORS[error] }, 403);
}

/** POST /check-code：只验码和查剩余次数，不扣次、不调上游、不计限流，给前端输码时即时反馈用 */
async function handleCheckCode(request, env) {
let payload;
try {
payload = await request.json();
} catch (e) {
payload = null;
}
const check = await verifyCode(env, payload && payload.code);
if (check.error) {
return jsonResponse({ valid: false, error: check.error, message: CODE_ERRORS[check.error] }, 403);
}
return jsonResponse({ valid: true, usesLeft: CODE_MAX_USES - check.used }, 200);
}

async function handleAnalyze(request, env) {
if (!env.DASHSCOPE_API_KEY) {
return jsonResponse(
{
error: "not_configured",
message:
"分析服务还没配置好：Worker 里还没有设置 DASHSCOPE_API_KEY（百炼 API Key）。请按 README 到 Cloudflare 后台添加这个密钥变量。",
},
503
);
}

let payload;
try {
payload = await request.json();
} catch (e) {
return jsonResponse(
{ error: "bad_json", message: "请求格式不对：需要 JSON 格式的请求体。"},
400
);
}

const imageBase64 = payload && payload.image_base64;
if (!imageBase64 || typeof imageBase64!== "string" || imageBase64.length < 100) {
return jsonResponse(
{ error: "image_required", message: "没有收到有效的照片数据，请重新上传照片再试。"},
400
);
}
if (imageBase64.length > MAX_IMAGE_BASE64_LEN) {
return jsonResponse(
{ error: "image_too_large", message: "照片太大了，请换一张小一点的照片，或等页面压缩后再试。"},
413
);
}

// 照片校验过了、调用上游之前，先验兑换码（一人一码）：缺码/假码/用满直接 403
const codeCheck = await verifyCode(env, payload && payload.code);
if (codeCheck.error) return codeErrorResponse(codeCheck.error);

// 验码通过，再过两道限流保险（触发限流直接返回 429）
const limitResponse = await checkRateLimits(request, env);
if (limitResponse) return limitResponse;

let scene = payload && payload.scene;
if (!SCENES.includes(scene)) scene = "初次见面";

const dataUri = imageBase64.startsWith("data:")
? imageBase64
: "data:image/jpeg;base64," + imageBase64;
const model = env.MODEL || DEFAULT_MODEL;

let upstream;
try {
upstream = await callDashScope(env.DASHSCOPE_API_KEY, model, dataUri, scene, true);
if (upstream.status === 400) {
// 可能是当前模型不支持 response_format，去掉后重试一次
const text = await upstream.text();
if (/response_format/i.test(text)) {
upstream = await callDashScope(env.DASHSCOPE_API_KEY, model, dataUri, scene, false);
} else {
return jsonResponse(
{
error: "upstream_failed",
message: "AI 分析服务拒绝了这次请求（400），请稍后再试；如果反复出现，可能是照片格式不支持，换一张 JPG 试试。",
},
502
);
}
}
} catch (e) {
return jsonResponse(
{ error: "upstream_unreachable", message: "连不上 AI 分析服务，请稍后再试一次。"},
502
);
}

if (!upstream.ok) {
return jsonResponse(
{
error: "upstream_failed",
message:
"AI 分析服务暂时不可用（上游返回 " + upstream.status + "），请稍后再试一次。如果反复失败，请管理员检查百炼 API Key 和模型开通状态。",
},
502
);
}

let data;
try {
data = await upstream.json();
} catch (e) {
return jsonResponse(
{ error: "upstream_bad_response", message: "AI 返回的内容看不懂，请再试一次。"},
502
);
}

const content =
data &&
data.choices &&
data.choices[0] &&
data.choices[0].message &&
data.choices[0].message.content;
const parsed = tolerantParseJson(typeof content === "string"? content: "");
const report = parsed && normalizeReport(parsed);
if (!report) {
return jsonResponse(
{ error: "upstream_bad_response", message: "AI 返回的报告不完整，请再点一次开始分析重试。"},
502
);
}

report.scene = scene;
// 成功产出报告后才给兑换码扣 1 次：上游失败不扣次，不坑付费用户。
// 没绑 KV（本地调试）时跳过计数，usesLeft 按未用过计算。
let usesLeft = CODE_MAX_USES - codeCheck.used;
if (env.LIMITS) {
const newUsed = codeCheck.used + 1;
await env.LIMITS.put("code:" + codeCheck.hash, String(newUsed), { expirationTtl: CODE_USE_TTL_SECONDS });
usesLeft = CODE_MAX_USES - newUsed;
}
report.usesLeft = usesLeft;
return jsonResponse(report, 200);
}

export default {
async fetch(request, env) {
const url = new URL(request.url);

if (request.method === "OPTIONS") {
return new Response(null, { status: 204, headers: corsHeaders()});
}

if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
return new Response("初见雷达 Worker 正常运行。POST /analyze 开始分析，POST /check-code 查兑换码剩余次数。\n", {
status: 200,
headers: { "Content-Type": "text/plain; charset=utf-8",...corsHeaders()},
});
}

if (request.method === "POST" && url.pathname === "/analyze") {
return handleAnalyze(request, env);
}

if (request.method === "POST" && url.pathname === "/check-code") {
return handleCheckCode(request, env);
}

return jsonResponse({ error: "not_found", message: "没有这个接口。"}, 404);
},
};
