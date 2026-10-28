export async function api(path: string, input?: any): Promise<any> {
  const r = await fetch(
    `/api/${path}`,
    input === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        },
  );
  const data = await r.json();
  if (!r.ok)
    throw Object.assign(new Error(data.error?.message ?? "请求失败"), {
      code: data.error?.code,
    });
  return data;
}
export const call = (tool: string, input: any) => api("call", { tool, input });
export const operationId = () => `ui_${crypto.randomUUID()}`;
export async function waitJob(
  projectId: string,
  job: any,
  onUpdate?: (j: any) => void,
): Promise<any> {
  let j = job;
  while (["queued", "running"].includes(j.status)) {
    onUpdate?.(j);
    await new Promise((r) => setTimeout(r, 300));
    j = await call("job_get", { projectId, jobId: j.id });
  }
  onUpdate?.(j);
  if (["failed", "cancelled", "interrupted"].includes(j.status))
    throw Object.assign(new Error(j.error?.message ?? `任务${j.status}`), {
      code: j.error?.code,
    });
  return j.result;
}
