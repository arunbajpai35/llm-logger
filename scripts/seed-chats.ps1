param([string]$BaseUrl = "http://localhost:3000")

$prompts = @(
    @{ provider = "openai"; message = "Explain prompt caching in one paragraph." },
    @{ provider = "openai"; message = "Write a SQL query for the top 5 slowest p95 hours." },
    @{ provider = "groq";   message = "Compare Postgres vs Clickhouse for log analytics." },
    @{ provider = "groq";   message = "Draft release notes for an LLM observability tool." },
    @{ provider = "openai"; message = "What is BullMQ and when would I use it?" }
)

foreach ($p in $prompts) {
    $body = @{ message = $p.message; provider = $p.provider } | ConvertTo-Json -Compress
    Write-Host "[$($p.provider)] $($p.message)"
    try {
        $resp = Invoke-WebRequest -Uri "$BaseUrl/api/chat" -Method POST `
            -ContentType "application/json" -Body $body `
            -UseBasicParsing -TimeoutSec 60
        $size = $resp.Content.Length
        Write-Host "  -> bytes streamed: $size"
    } catch {
        Write-Host "  -> ERROR: $($_.Exception.Message)"
    }
}
