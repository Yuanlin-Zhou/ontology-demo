package com.example.file.service;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** bad.java: 线程名不可读，出问题时无法从线程转储定位业务；同时没有监控与关闭。 */
public class FileProcessService {

    private final ThreadPoolExecutor processor = new ThreadPoolExecutor(
            4, 8, 60L, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(100),
            new UnnamedThreadFactory(),
            new ThreadPoolExecutor.AbortPolicy());

    public void process(String fileId) {
        processor.execute(() -> handle(fileId));
    }

    private void handle(String fileId) {
    }

    static class UnnamedThreadFactory implements ThreadFactory {
        @Override
        public Thread newThread(Runnable task) {
            return new Thread(task);
        }
    }
}
