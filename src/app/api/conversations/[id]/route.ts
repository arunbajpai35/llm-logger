import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  // Cap at 500 messages — UI doesn't paginate yet, so bound the payload.
  const convo = await prisma.conversation.findUnique({
    where: { id: params.id },
    include: { messages: { orderBy: { createdAt: "asc" }, take: 500 } },
  });
  if (!convo) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(convo);
}

// PATCH to update status (e.g. cancel)
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (body?.status && !["active", "cancelled", "completed"].includes(body.status)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }
  try {
    const updated = await prisma.conversation.update({
      where: { id: params.id },
      data: { status: body?.status },
    });
    return NextResponse.json(updated);
  } catch {
    // Prisma throws P2025 when the record doesn't exist. Surface as 404
    // rather than letting the 500 leak the Prisma stack to the client.
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  await prisma.conversation.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
