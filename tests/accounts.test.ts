import assert from "node:assert/strict";
import { verifyAccount } from "../lib/kaggle";

async function main() {
  const originalFetch = globalThis.fetch;
  const token = "KGAT_test_token_for_accounts_only";
  let calls = 0;
  try {
    // 全新账户即使没有 Notebook，也能通过密钥查询身份。
    globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(String(url),"https://www.kaggle.com/api/v1/oauth2/introspect");
      assert.equal(init?.method,"POST");
      assert.deepEqual(JSON.parse(String(init?.body)),{token});
      return Response.json({active:true,username:"BrandNewUser"});
    };
    assert.equal(await verifyAccount(token),"brandnewuser");
    assert.equal(calls,1);
    await assert.rejects(verifyAccount(token,"otheruser"),/不一致/);
    globalThis.fetch = async () => Response.json({active:false});
    await assert.rejects(verifyAccount(token),/已过期或已撤销/);
    globalThis.fetch = async () => Response.json({active:true});
    await assert.rejects(verifyAccount(token),/未返回有效用户名/);
    globalThis.fetch = async () => { throw new Error(token); };
    await assert.rejects(verifyAccount(token),e => e instanceof Error && !e.message.includes(token) && /连接暂时中断/.test(e.message));
    globalThis.fetch = async () => new Response(token,{status:502});
    await assert.rejects(verifyAccount(token),e => e instanceof Error && !e.message.includes(token));
    console.log("通过：无 Notebook 新账户自动识别、身份匹配、失效密钥、缺失身份、网络与响应错误不泄露密钥。");
  } finally { globalThis.fetch = originalFetch; }
}
main().catch(e => { console.error(e); process.exitCode=1; });
