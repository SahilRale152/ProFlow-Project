import { motion, type Variants } from "framer-motion";
import type { ReactNode } from "react";

interface FadeInProps {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
  /** Stagger children of this element by this amount (seconds) */
  stagger?: number;
}

const item: Variants = {
  hidden: { opacity: 0, y: 16 },
  show: { opacity: 1, y: 0 },
};

/**
 * FadeIn — drop-in wrapper that animates its children in on mount / on
 * scroll into view. Use it around cards, list rows, page headers, etc.
 *
 *   <FadeIn><Card>...</Card></FadeIn>
 *   <FadeIn delay={0.1}><Card>...</Card></FadeIn>
 */
export function FadeIn({ children, delay = 0, y = 16, className, stagger }: FadeInProps) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-40px" }}
      transition={{ duration: 0.45, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {stagger !== undefined ? (
        <motion.div
          variants={{ show: { transition: { staggerChildren: stagger } } }}
          initial="hidden"
          animate="show"
        >
          {children}
        </motion.div>
      ) : (
        children
      )}
    </motion.div>
  );
}

/** Use as a direct child of a stagger container created with FadeIn stagger prop */
export function FadeInItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div className={className} variants={item} transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}>
      {children}
    </motion.div>
  );
}