import { Router } from "express";
import { asyncHandler } from "../../middleware/errorHandler.js";
import { sendSuccess, sendError } from "../../utils/response.js";
import { ErrorCode } from "../../types/api.js";
import { db } from "../../../db.js";
import { users, cards, gradingCompanies } from "../../../drizzle/schema.js";
import { eq, and, isNull, sql } from "drizzle-orm";

const router = Router();

// GET /public/u/:username
router.get(
  "/:username",
  asyncHandler(async (req, res) => {
    const slug = (req.params.username as string).toLowerCase().trim();

    const user = await db.query.users.findFirst({
      where: and(
        sql`LOWER(${users.username}) = ${slug}`,
        eq(users.profilePublic, true)
      ),
      columns: {
        id: true,
        firstName: true,
        lastName: true,
        username: true,
        bio: true,
        showValues: true,
        avatarUrl: true,
        createdAt: true,
        role: true,
      },
    });

    if (!user) {
      return sendError(res, 404, ErrorCode.NOT_FOUND, "Profile not found", req.requestId);
    }

    const publicCards = await db
      .select({
        id:            cards.id,
        name:          cards.name,
        category:      cards.category,
        year:          cards.year,
        setName:       cards.setName,
        cardNumber:    cards.cardNumber,
        condition:     cards.condition,
        isRookie:      cards.isRookie,
        isAutographed: cards.isAutographed,
        isPatch:       cards.isPatch,
        isGraded:      cards.isGraded,
        gradeValue:    cards.gradeValue,
        gradeCompany:  gradingCompanies.abbr,
        certNumber:    cards.certNumber,
        currentValue:  cards.currentValue,
        imageUrl:      cards.imageUrl,
        imageBackUrl:  cards.imageBackUrl,
        status:        cards.status,
        createdAt:     cards.createdAt,
      })
      .from(cards)
      .leftJoin(gradingCompanies, eq(gradingCompanies.id, cards.gradeCompanyId))
      .where(
        and(
          eq(cards.userId, user.id),
          eq(cards.isPublic, true),
          isNull(cards.deletedAt)
        )
      )
      .orderBy(sql`${cards.createdAt} DESC`);

    const cardsOut = publicCards.map((c) => ({
      ...c,
      currentValue: user.showValues ? c.currentValue : null,
    }));

    const totalValue = user.showValues
      ? publicCards.reduce((sum, c) => sum + (c.currentValue ? parseFloat(c.currentValue) : 0), 0)
      : null;

    sendSuccess(res, {
      user: {
        username:    user.username,
        name:        [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username,
        bio:         user.bio,
        showValues:  user.showValues,
        avatarUrl:   user.avatarUrl ?? null,
        memberSince: user.createdAt,
        isFounder:   user.id <= 100,
        isOwner:     user.role === "admin",
      },
      stats: {
        cardCount:  cardsOut.length,
        totalValue: totalValue !== null ? Math.round(totalValue * 100) / 100 : null,
      },
      cards: cardsOut,
    }, 200, req.requestId);
  })
);

export default router;
