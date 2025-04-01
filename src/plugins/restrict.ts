import type { BotPlugin, MessageEventContext } from "../features";

const banStickers = [
    "p1_wmtz5638525934_by_WuMingv2Bot", "Dongzhiminaiguailing",
    "p3_wmtz5638525934_by_WuMingv2Bot", "p4_wmtz5638525934_by_WuMingv2Bot", "p5_wmtz5638525934_by_WuMingv2Bot",
    "p6_wmtz5638525934_by_WuMingv2Bot", "w3_wmtz5638525934_by_WuMingv2Bot", "w4_wmtz5638525934_by_WuMingv2Bot",
    "p7_wmtz5638525934_by_WuMingv2Bot", "p8_wmtz5638525934_by_WuMingv2Bot", "p9_wmtz5638525934_by_WuMingv2Bot",
    "w1_wmtz5627235150_by_WuMingv2Bot", "p0_wmtz5627235150_by_WuMingv2Bot", "lessxy",
    "LesBiansexygirl", "luoxin", "ar1514_by_fStikBot",
    "ar1513_by_fStikBot", "ar1385_by_fStikBot", "ar1507_by_fStikBot",
    "ar1497_by_fStikBot", "ar1493_by_fStikBot", "ar1490_by_fStikBot",
    "ar1487_by_fStikBot", "ar1480_by_fStikBot", "ar1476_by_fStikBot",
    "ar1472_by_fStikBot", "ar1475_by_fStikBot", "ar1471_by_fStikBot",
    "ar1460_by_fStikBot", "ar1459_by_fStikBot", "ar1453_by_fStikBot",
    "ar1452_by_fStikBot", "ar1451_by_fStikBot", "ar1440_by_fStikBot",
    'ar1429_by_fStikBot', "jiuri105_by_fStikBot", "ar1421_by_fStikBot",
    "ar1420_by_fStikBot", "ar1418_by_fStikBot", "ar1415_by_fStikBot",
    "ar1414_by_fStikBot", "ar1410_by_fStikBot", "ar1409_by_fStikBot",
    "ar1408_by_fStikBot", "ar1386_by_fStikBot", "ar1385_by_fStikBot",
    "ar1380_by_fStikBot", "ar1377_by_fStikBot", "SeshotHot163_by_STPacker_bot",
    "creampied4", "h3ntstikers_Cerber_by_fStikBot", "h3ntstikers_Yooshok_artist_by_fStikBot",
    "TWZP2024_by_moe_sticker_bot", "obzs99999", "kaiche",
    "kaiche8", "kaiche9", "freeman110_by_fStikBot",
    "dkfkfjekee_by_fStikBot", "theDictators", "GuoHanMingWhore_by_fStikBot",
    "shenfu_by_fStikBot", "w1_wmtz5638525934_by_WuMingv2Bot",
    "jilefang", "imisVAN", "WinnieXi4",
    "pldgirls", "Sinoxodus", "fanchabiaodanganguan_by_luxiaoxun_bot",
    "tushazhina", "sexNfun", "Ke3f4c0114c82694c4f86_by_StickerStealRobot",
    "Kefb40400ea82694c4f86_by_StickerStealRobot", "K509aff5cb582694c4f86_by_StickerStealRobot"
];

const plugin: BotPlugin = {
    name: 'Restrict',
    description: 'Example plugin',
    version: '1.0.0',
    
    events: [
        {
            type: 'message',
            
            // Event handler function
            async handler(ctx: MessageEventContext): Promise<void> {
                const stickers = await ctx.message.getCustomEmojis();
                if (stickers.length > 0) {
                    console.log(stickers[0]?.attr.stickerset)
                    console.log(stickers[0]?.attr.stickerset._)
                }
            }
        }
    ]
};

export default plugin;