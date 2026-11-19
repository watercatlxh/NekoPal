import { type Static, Type } from "typebox";

/**
 * NekoPal daemon configuration: the `[nekopal]` table of `settings.toml`.
 *
 * The gateway reads it through `SettingsManager.getNekoPal()`, which merges this
 * schema's defaults with whatever the file sets.
 */
export const NekoPalSettingsSchema = Type.Object({
	defaultLang: Type.Optional(
		Type.Union([Type.Literal("en"), Type.Literal("zh")], {
			description: "Language for replies before a chat picks one with /lang.",
			default: "en",
		}),
	),
	workspace: Type.Optional(
		Type.String({
			description:
				'Working directory of the agent, such as "~/.nekopal/workspace". "~" expands to the home directory.',
			default: "~/.nekopal/workspace",
		}),
	),
	channels: Type.Optional(
		Type.Object({
			telegram: Type.Optional(
				Type.Object({
					enabled: Type.Optional(Type.Boolean({ default: false })),
					botToken: Type.Optional(
						Type.String({
							description: 'Bot token, or "$ENV_NAME" / "!command" resolved at startup.',
							default: "$TELEGRAM_BOT_TOKEN",
						}),
					),
					allowedUsers: Type.Optional(
						Type.Array(Type.Integer(), {
							description: "Telegram user ids allowed to talk to the bot. Empty ignores every message.",
						}),
					),
				}),
			),
			qq: Type.Optional(
				Type.Object({
					enabled: Type.Optional(Type.Boolean({ default: false })),
					appId: Type.Optional(Type.String({ default: "" })),
					appSecret: Type.Optional(
						Type.String({
							description: 'Bot secret, or "$ENV_NAME" / "!command" resolved at startup.',
							default: "$QQ_BOT_SECRET",
						}),
					),
					allowedOpenIds: Type.Optional(
						Type.Array(Type.String(), {
							description: "QQ openids allowed to talk to the bot. Empty ignores every message.",
						}),
					),
					stream: Type.Optional(Type.Boolean({ default: true })),
					proactivePerMinute: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, default: 18 })),
					proactivePerDay: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, default: 1000 })),
				}),
			),
		}),
	),
	memory: Type.Optional(
		Type.Object({
			memoryChars: Type.Optional(Type.Integer({ minimum: 100, maximum: 10000, default: 2200 })),
			userChars: Type.Optional(Type.Integer({ minimum: 100, maximum: 10000, default: 1375 })),
			reviewEveryTurns: Type.Optional(
				Type.Integer({
					minimum: 0,
					maximum: 1000,
					default: 10,
					description: "Review the conversation for memories every N user turns; 0 disables the review.",
				}),
			),
		}),
	),
});

export type NekoPalSettings = Static<typeof NekoPalSettingsSchema>;

/** Every `[nekopal]` default, with nested tables fully populated. */
export const NEKOPAL_DEFAULTS = {
	defaultLang: "en",
	workspace: "~/.nekopal/workspace",
	channels: {
		telegram: { enabled: false, botToken: "$TELEGRAM_BOT_TOKEN", allowedUsers: [] as number[] },
		qq: {
			enabled: false,
			appId: "",
			appSecret: "$QQ_BOT_SECRET",
			allowedOpenIds: [] as string[],
			stream: true,
			proactivePerMinute: 18,
			proactivePerDay: 1000,
		},
	},
	memory: { memoryChars: 2200, userChars: 1375, reviewEveryTurns: 10 },
} as const satisfies NekoPalSettings;
