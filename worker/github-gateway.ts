interface GatewayEnv {
  GITHUB_TOKEN: string;
  GATEWAY_API_KEY: string;
}

const TARGET_OWNER = "mikhaildezprofi-glitch";
const TARGET_REPO = "free-cloud-youtube-studio";
const MAX_BODY_BYTES = 200_000;
const MAX_FILES = 10;
const MAX_FILE_BYTES = 100_000;

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function validPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length < 1 || path.length > 200) {
    return false;
  }

  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("%") ||
    path.split("/").some((part) => part === ".." || part === "." || part === "")
  ) {
    return false;
  }

  const blocked = [
    /^\.github\/workflows(?:\/|$)/i,
    /(^|\/)\.env(?:$|\.)/i,
    /(^|\/)(secrets?|credentials?)(\/|$)/i,
    /^worker\/github-gateway\.ts$/i,
  ];

  return !blocked.some((pattern) => pattern.test(path));
}

async function github(
  token: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "Cloudflare-Restricted-GitHub-Gateway",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export async function handleGitHubGateway(
  request: Request,
  env: GatewayEnv,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!env.GATEWAY_API_KEY) {
    return json({ error: "Unauthorized" }, 401);
  }

  const expected = `Bearer ${env.GATEWAY_API_KEY}`;
  const actual = request.headers.get("Authorization") ?? "";

  if (!safeEqual(actual, expected)) {
    return json({ error: "Unauthorized" }, 401);
  }

  if (!env.GITHUB_TOKEN) {
    return json({ error: "Gateway configuration error" }, 500);
  }

  const declaredLength = Number(
    request.headers.get("Content-Length") ?? "0",
  );

  if (declaredLength > MAX_BODY_BYTES) {
    return json({ error: "Request too large" }, 413);
  }

  let body: unknown;

  try {
    const raw = await request.text();

    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json({ error: "Request too large" }, 413);
    }

    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("files" in body) ||
    !Array.isArray(body.files)
  ) {
    return json({ error: "Expected a files array" }, 400);
  }

  const files = body.files as unknown[];

  if (files.length < 1 || files.length > MAX_FILES) {
    return json({ error: `Provide 1 to ${MAX_FILES} files` }, 400);
  }

  const seen = new Set<string>();

  for (const item of files) {
    if (
      typeof item !== "object" ||
      item === null ||
      !("path" in item) ||
      !("content" in item)
    ) {
      return json({ error: "Each file needs path and content" }, 400);
    }

    const file = item as { path: unknown; content: unknown };

    if (
      !validPath(file.path) ||
      typeof file.content !== "string" ||
      new TextEncoder().encode(file.content).byteLength > MAX_FILE_BYTES ||
      seen.has(file.path)
    ) {
      return json({ error: "Invalid, duplicate, or oversized file" }, 400);
    }

    seen.add(file.path);
  }

  const apiBase = `/repos/${TARGET_OWNER}/${TARGET_REPO}`;
  const branch = `gateway/proposal-${crypto.randomUUID()}`;

  try {
    const baseResponse = await github(
      env.GITHUB_TOKEN,
      `${apiBase}/git/ref/heads/main`,
    );

    if (!baseResponse.ok) {
      return json({ error: "Could not read base branch" }, 502);
    }

    const baseData = (await baseResponse.json()) as {
      object: { sha: string };
    };

    const branchResponse = await github(
      env.GITHUB_TOKEN,
      `${apiBase}/git/refs`,
      "POST",
      {
        ref: `refs/heads/${branch}`,
        sha: baseData.object.sha,
      },
    );

    if (!branchResponse.ok) {
      return json({ error: "Could not create proposal branch" }, 502);
    }

    for (const item of files as { path: string; content: string }[]) {
      const encodedPath = item.path
        .split("/")
        .map(encodeURIComponent)
        .join("/");

      const existingResponse = await github(
        env.GITHUB_TOKEN,
        `${apiBase}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
      );

      let existingSha: string | undefined;

      if (existingResponse.ok) {
        const existingData = (await existingResponse.json()) as {
          sha?: string;
          type?: string;
        };

        if (existingData.type !== "file" || !existingData.sha) {
          return json({
            error: "Target path is not a regular file",
            branch,
          }, 400);
        }

        existingSha = existingData.sha;
      } else if (existingResponse.status !== 404) {
        return json({
          error: "Could not check existing file",
          branch,
        }, 502);
      }

      const payload: {
        message: string;
        content: string;
        branch: string;
        sha?: string;
      } = {
        message: `Proposed update: ${item.path}`,
        content: btoa(
          Array.from(
            new TextEncoder().encode(item.content),
            (byte) => String.fromCharCode(byte),
          ).join(""),
        ),
        branch,
      };

      if (existingSha) {
        payload.sha = existingSha;
      }

      const result = await github(
        env.GITHUB_TOKEN,
        `${apiBase}/contents/${encodedPath}`,
        "PUT",
        payload,
      );

      if (!result.ok) {
        return json({
          error: "A file update failed; proposal branch may be incomplete",
          branch,
        }, 502);
      }
    }

    const prResponse = await github(
      env.GITHUB_TOKEN,
      `${apiBase}/pulls`,
      "POST",
      {
        title: "Automated code proposal",
        head: branch,
        base: "main",
        body: "Draft proposal created by the restricted Cloudflare gateway. Review all changes before merging.",
        draft: true,
      },
    );

    if (!prResponse.ok) {
      return json({
        error: "Files were proposed, but draft PR creation failed",
        branch,
      }, 502);
    }

    const pr = (await prResponse.json()) as {
      number: number;
      html_url: string;
      draft: boolean;
    };

    return json({
      success: true,
      branch,
      pullRequestNumber: pr.number,
      pullRequestUrl: pr.html_url,
      draft: pr.draft,
    }, 201);
  } catch {
    return json({ error: "Gateway request failed" }, 502);
  }
}
