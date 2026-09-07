import { motion } from "framer-motion";
import Link from "next/link";

export const Greeting = () => (
  <div className="flex flex-col items-center px-4" key="overview">
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="text-center font-semibold text-2xl tracking-tight text-foreground md:text-3xl"
      initial={{ opacity: 0, y: 10 }}
      transition={{ delay: 0.35, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      What would you like to do?
    </motion.div>
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="mt-3 text-center text-muted-foreground/80 text-sm"
      initial={{ opacity: 0, y: 10 }}
      transition={{ delay: 0.5, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      Say it in a sentence. Nothing moves until you sign it.
    </motion.div>
    <motion.div
      animate={{ opacity: 1, y: 0 }}
      className="mt-2 text-center text-muted-foreground/60 text-xs"
      initial={{ opacity: 0, y: 10 }}
      transition={{ delay: 0.65, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
    >
      Swaps happen here. To have a liquidity position kept near the market
      price,{" "}
      <Link
        className="underline underline-offset-2 hover:text-muted-foreground"
        href="/mandate"
      >
        set a mandate
      </Link>
      .
    </motion.div>
  </div>
);
