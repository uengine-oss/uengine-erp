import asyncio, json, os, urllib.request
from langchain_mcp_adapters.client import MultiServerMCPClient
API, KEY = os.environ["API_URL"], os.environ["ANON_KEY"]
def post(path, body, token=None):
    req = urllib.request.Request(f"{API}{path}", data=json.dumps(body).encode(), method="POST",
        headers={"apikey": KEY, "Content-Type": "application/json", "Authorization": f"Bearer {token or KEY}"})
    try:
        with urllib.request.urlopen(req) as r: return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or b"null")
def login(email, pw): return post("/auth/v1/token?grant_type=password", {"email": email, "password": pw})[1]["access_token"]
def client(tok):
    return MultiServerMCPClient({"erp": {"transport": "streamable_http", "url": f"{API}/rest/v1/rpc/erp_mcp", "headers": {"apikey": KEY, "Authorization": f"Bearer {tok}"}}})
def as_text(x):
    x = x[0] if isinstance(x, tuple) else x
    return x if isinstance(x, str) else "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in x)
def key_client(key):
    # The shape Process GPT stores for an http MCP server: url + headers, no login.
    return MultiServerMCPClient({"erp": {"transport": "streamable_http", "url": f"{API}/rest/v1/rpc/erp_mcp", "headers": {"apikey": KEY, "Authorization": f"Bearer {KEY}", "x-erp-key": key}}})
async def main():
    admin = login(os.environ.get("MCP_ADMIN", "owner@example.com"), os.environ.get("MCP_PASS", "owner-pass-1234"))
    tools = {t.name: t for t in await client(admin).get_tools()}
    print("get_tools:", sorted(tools))
    print("read types:", as_text(await tools["erp_read"].ainvoke({}))[:80])
    made = json.loads(as_text(await tools["erp_create"].ainvoke({"type": "tag", "values": {"name": "py-" + os.urandom(3).hex()}})))
    print("create via langchain:", made["type"], "v%s" % made["version"], [e["type"] for e in made["events"]])
    email = "mcp-viewer-" + os.urandom(3).hex() + "@example.com"
    st, _ = post("/rest/v1/rpc/erp_command", {"p_type": "member", "p_id": None, "p_command": "create", "p_payload": {"name": "조회 전용", "email": email, "password": "viewer-pass-1234", "roles": ["viewer"]}}, admin)
    print("viewer account:", st)
    member_id = _["id"]
    st2, k = post("/rest/v1/rpc/erp_api_key_create", {"p_member_id": member_id, "p_label": "python"}, admin)
    print("key:", st2, k["prefix"])
    vt = {t.name: t for t in await key_client(k["key"]).get_tools()}
    print("viewer read:", as_text(await vt["erp_read"].ainvoke({"type": "tag", "limit": 1}))[:70])
    try:
        print("viewer create:", as_text(await vt["erp_create"].ainvoke({"type": "tag", "values": {"name": "침입"}}))[:90])
    except Exception as e:
        print("viewer create refused:", type(e).__name__, str(e)[:90])
asyncio.run(main())
